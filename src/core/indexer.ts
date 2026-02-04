import { createHash } from 'crypto';
import { encoding_for_model } from 'tiktoken';
import { VoyageAIClient } from 'voyageai';

export type EmbeddingProvider = 'voyage' | 'local';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  apiKey?: string;
  model?: string;
  batchSize?: number; // Batch size for local embeddings (default: 8)
}

const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, string> = {
  voyage: 'voyage-3-lite',
  local: 'Xenova/all-MiniLM-L6-v2',
};

let localPipeline: any = null;

export interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
}

interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
}

export function chunkText(text: string, options?: ChunkOptions): Chunk[] {
  const chunkSize = options?.chunkSize ?? 400;
  const overlap = options?.overlap ?? 40;

  const enc = encoding_for_model('gpt-4');
  const lines = text.split('\n');

  const chunks: Chunk[] = [];
  let currentChunkLines: string[] = [];
  let currentStartLine = 0;
  let previousChunkEndLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentChunkLines.push(line);

    const chunkText = currentChunkLines.join('\n');
    const tokenCount = enc.encode(chunkText).length;

    if (tokenCount >= chunkSize || i === lines.length - 1) {
      let finalChunkLines = currentChunkLines;
      let finalStartLine = currentStartLine;

      if (chunks.length > 0 && previousChunkEndLines.length > 0) {
        let overlapTokens = 0;
        let trimFromStart = 0;

        for (let j = 0; j < finalChunkLines.length; j++) {
          overlapTokens = enc.encode(finalChunkLines.slice(0, j + 1).join('\n')).length;
          if (overlapTokens >= overlap) {
            trimFromStart = j + 1;
            break;
          }
        }

        if (previousChunkEndLines.length > 0) {
          finalChunkLines = [...previousChunkEndLines, ...finalChunkLines];
          finalStartLine = currentStartLine - previousChunkEndLines.length;
        }
      }

      const chunkText = finalChunkLines.join('\n');
      if (chunkText.trim()) {
        chunks.push({
          text: chunkText,
          startLine: finalStartLine,
          endLine: i,
        });
      }

      let overlapTokens = 0;

      for (let j = finalChunkLines.length - 1; j >= 0; j--) {
        const testLines = finalChunkLines.slice(j);
        overlapTokens = enc.encode(testLines.join('\n')).length;
        if (overlapTokens >= overlap) {
          previousChunkEndLines = testLines;
          break;
        }
      }

      if (previousChunkEndLines.length === 0 && finalChunkLines.length > 0) {
        previousChunkEndLines = finalChunkLines.slice(-Math.max(1, Math.floor(finalChunkLines.length / 2)));
      }

      currentChunkLines = [];
      currentStartLine = i + 1;
    }
  }

  return chunks;
}

export async function generateEmbeddings(
  texts: string[],
  config: EmbeddingConfig
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const model = config.model || DEFAULT_EMBEDDING_MODELS[config.provider];

  if (config.provider === 'voyage') {
    return generateEmbeddingsVoyage(texts, config.apiKey!, model);
  }
  return generateEmbeddingsLocal(texts, model, config.batchSize);
}

async function generateEmbeddingsVoyage(
  texts: string[],
  apiKey: string,
  model: string
): Promise<number[][]> {
  const client = new VoyageAIClient({ apiKey });

  const maxChars = 120000;
  const truncatedTexts = texts.map((text) =>
    text.length > maxChars ? text.slice(0, maxChars) : text
  );

  try {
    const response = await client.embed({
      input: truncatedTexts,
      model: model,
    });

    if (!response.data) {
      throw new Error('No embedding data returned from Voyage AI');
    }

    const embeddings = response.data.map((item) => {
      if (!item.embedding) {
        throw new Error('Missing embedding in Voyage AI response');
      }
      return item.embedding as number[];
    });

    return embeddings;
  } catch (error) {
    throw new Error(
      `Voyage AI embeddings error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function generateEmbeddingsLocal(
  texts: string[],
  model: string,
  batchSize: number = 8
): Promise<number[][]> {
  try {
    if (!localPipeline) {
      const { pipeline } = await import('@xenova/transformers');
      localPipeline = await pipeline('feature-extraction', model, {
        quantized: true,
      });
    }

    const embeddings: number[][] = [];
    
    // Process texts in batches for better performance
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      
      // Process batch in parallel
      const batchPromises = batch.map(async (text) => {
        const truncated = text.length > 8000 ? text.slice(0, 8000) : text;
        
        const output = await localPipeline(truncated, {
          pooling: 'mean',
          normalize: true,
        });
        
        // Convert output.data to number array
        const data = output.data as Float32Array | number[];
        return Array.from(data) as number[];
      });
      
      const batchResults = await Promise.all(batchPromises);
      embeddings.push(...batchResults);
    }

    return embeddings;
  } catch (error) {
    throw new Error(
      `Local embeddings error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
