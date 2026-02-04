import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { deleteChunksByPath, insertChunk } from './database.js';
import { chunkText, hashContent, generateEmbeddings, type EmbeddingConfig } from './indexer.js';
import { callLLM, type LLMConfig } from './llm.js';

export interface MemoryEntry {
  timestamp: string;
  content: string;
  lineStart: number;
  lineEnd: number;
}

export interface CompactionResult {
  originalEntries: number;
  finalEntries: number;
  removedDuplicates: number;
  originalSizeKB: number;
  finalSizeKB: number;
  mode: 'quick' | 'deep';
  errors: string[];
}

/**
 * Parses a daily memory file into individual entries
 * Entries are separated by ## timestamp headers
 */
export function parseMemoryFile(content: string): MemoryEntry[] {
  const lines = content.split('\n');
  const entries: MemoryEntry[] = [];
  let currentEntry: Partial<MemoryEntry> | null = null;
  let currentLines: string[] = [];
  let currentStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const timestampMatch = line.match(/^## (\d{1,2}:\d{2})/);

    if (timestampMatch) {
      // Save previous entry if exists
      if (currentEntry && currentLines.length > 0) {
        entries.push({
          timestamp: currentEntry.timestamp!,
          content: currentLines.join('\n').trim(),
          lineStart: currentStartLine,
          lineEnd: i - 1,
        });
      }

      // Start new entry
      currentEntry = { timestamp: timestampMatch[1] };
      currentLines = [line];
      currentStartLine = i;
    } else if (currentEntry) {
      currentLines.push(line);
    } else if (line.startsWith('# ')) {
      // Skip the date header line
      continue;
    }
  }

  // Don't forget the last entry
  if (currentEntry && currentLines.length > 0) {
    entries.push({
      timestamp: currentEntry.timestamp!,
      content: currentLines.join('\n').trim(),
      lineStart: currentStartLine,
      lineEnd: lines.length - 1,
    });
  }

  return entries;
}

/**
 * Calculates Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculates similarity ratio between two strings (0-1, 1 = identical)
 */
function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLen;
}

/**
 * Groups similar entries together using Levenshtein distance
 */
function findDuplicateGroups(
  entries: MemoryEntry[],
  similarityThreshold: number = 0.9
): MemoryEntry[][] {
  const used = new Set<number>();
  const groups: MemoryEntry[][] = [];

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;

    const group: MemoryEntry[] = [entries[i]];
    used.add(i);

    // Find similar entries
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;

      // Compare content (excluding timestamp line)
      const contentA = entries[i].content.replace(/^## \d{1,2}:\d{2}\n\n?/, '');
      const contentB = entries[j].content.replace(/^## \d{1,2}:\d{2}\n\n?/, '');

      const similarity = calculateSimilarity(contentA, contentB);
      if (similarity >= similarityThreshold) {
        group.push(entries[j]);
        used.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}

// ============================================================================
// TF-IDF Clustering for smarter topic-based grouping
// ============================================================================

interface TfIdfVector {
  terms: Map<string, number>;
  norm: number;
}

/**
 * Tokenize text into lowercase words, filtering short words
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

/**
 * Compute TF-IDF vectors for a list of entries
 */
function computeTfIdfVectors(entries: MemoryEntry[]): TfIdfVector[] {
  // Extract content without timestamp headers
  const docs = entries.map(e => 
    tokenize(e.content.replace(/^## \d{1,2}:\d{2}\n\n?/, ''))
  );

  // Build document frequency
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const term of doc) {
      if (!seen.has(term)) {
        df.set(term, (df.get(term) || 0) + 1);
        seen.add(term);
      }
    }
  }

  // Compute TF-IDF vectors
  const N = docs.length;
  return docs.map(doc => {
    // Term frequency
    const tf = new Map<string, number>();
    for (const term of doc) {
      tf.set(term, (tf.get(term) || 0) + 1);
    }

    // TF-IDF weights
    const terms = new Map<string, number>();
    let normSq = 0;
    for (const [term, count] of tf) {
      const idf = Math.log(N / (df.get(term) || 1));
      const tfidf = count * idf;
      terms.set(term, tfidf);
      normSq += tfidf * tfidf;
    }

    return { terms, norm: Math.sqrt(normSq) };
  });
}

/**
 * Compute cosine similarity between two TF-IDF vectors
 */
function tfidfCosineSimilarity(a: TfIdfVector, b: TfIdfVector): number {
  if (a.norm === 0 || b.norm === 0) return 0;

  let dot = 0;
  for (const [term, weight] of a.terms) {
    dot += weight * (b.terms.get(term) || 0);
  }
  return dot / (a.norm * b.norm);
}

/**
 * Cluster entries by TF-IDF similarity
 */
function clusterByTfIdf(
  entries: MemoryEntry[],
  vectors: TfIdfVector[],
  threshold: number = 0.7
): MemoryEntry[][] {
  const used = new Set<number>();
  const clusters: MemoryEntry[][] = [];

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;

    const cluster: MemoryEntry[] = [entries[i]];
    used.add(i);

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;

      const similarity = tfidfCosineSimilarity(vectors[i], vectors[j]);
      if (similarity >= threshold) {
        cluster.push(entries[j]);
        used.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Quick compaction: removes exact and near-duplicate entries
 * Uses TF-IDF clustering for topic grouping, then Levenshtein for deduplication
 */
export function quickCompact(entries: MemoryEntry[]): MemoryEntry[] {
  if (entries.length <= 1) {
    return entries;
  }

  // Step 1: TF-IDF clustering to group entries by topic (threshold 0.7)
  const vectors = computeTfIdfVectors(entries);
  const topicClusters = clusterByTfIdf(entries, vectors, 0.7);

  // Step 2: Within each topic cluster, apply Levenshtein deduplication
  const results: MemoryEntry[] = [];
  for (const cluster of topicClusters) {
    if (cluster.length === 1) {
      results.push(cluster[0]);
    } else {
      // Find near-duplicates within the cluster
      const dedupeGroups = findDuplicateGroups(cluster, 0.9);
      // Keep the most detailed entry from each duplicate group
      for (const group of dedupeGroups) {
        // Sort by content length descending, keep the most detailed
        const sorted = [...group].sort((a, b) => b.content.length - a.content.length);
        results.push(sorted[0]);
      }
    }
  }

  return results;
}

const SUMMARIZE_PROMPT = `You are a memory compaction assistant. Given these related memory entries, create a single consolidated entry that preserves all unique and important information.

Rules:
1. Combine related information into a coherent summary
2. Remove redundancy but preserve all unique facts
3. Keep the same markdown format with ## timestamp header
4. Use the timestamp of the most recent entry
5. Keep it concise but complete

Entries to consolidate:
"""
{ENTRIES}
"""

Return ONLY the consolidated entry in this format:
## HH:MM

[Consolidated content here]`;

/**
 * Deep compaction: uses LLM to intelligently summarize related entries
 */
async function summarizeEntryGroup(
  entries: MemoryEntry[],
  llmConfig: LLMConfig
): Promise<string> {
  if (entries.length === 1) {
    return entries[0].content;
  }

  const entriesText = entries.map(e => e.content).join('\n\n---\n\n');
  const prompt = SUMMARIZE_PROMPT.replace('{ENTRIES}', entriesText);

  try {
    const response = await callLLM(llmConfig, prompt, {
      temperature: 0.3,
      maxTokens: 1000,
    });

    return response.content || entries[entries.length - 1].content;
  } catch {
    // Fall back to keeping the most recent entry on error
    return entries[entries.length - 1].content;
  }
}

/**
 * Deep compaction: uses LLM to summarize clusters of related entries
 */
export async function deepCompact(
  entries: MemoryEntry[],
  llmConfig: LLMConfig
): Promise<MemoryEntry[]> {
  // First, find groups of similar entries
  const groups = findDuplicateGroups(entries, 0.7); // Lower threshold for deep mode

  const compactedEntries: MemoryEntry[] = [];

  for (const group of groups) {
    if (group.length === 1) {
      compactedEntries.push(group[0]);
    } else {
      // Use LLM to summarize the group
      const summarized = await summarizeEntryGroup(group, llmConfig);
      const lastEntry = group[group.length - 1];

      compactedEntries.push({
        timestamp: lastEntry.timestamp,
        content: summarized,
        lineStart: 0,
        lineEnd: 0,
      });
    }
  }

  return compactedEntries;
}

/**
 * Reconstructs a daily file from entries
 */
function reconstructFile(date: string, entries: MemoryEntry[]): string {
  const header = `# ${date}\n`;
  const content = entries.map(e => e.content).join('\n\n');
  return header + '\n' + content + '\n';
}

/**
 * Re-indexes a file after compaction
 */
async function reindexFile(
  db: Database.Database,
  filePath: string,
  relativePath: string,
  embeddingConfig: EmbeddingConfig
): Promise<void> {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Remove existing chunks
  deleteChunksByPath(db, relativePath);

  // Re-chunk and embed
  const chunks = chunkText(content);
  if (chunks.length === 0) return;

  const texts = chunks.map(c => c.text);
  const embeddings = await generateEmbeddings(texts, embeddingConfig);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkId = `${relativePath}:${chunk.startLine}-${chunk.endLine}`;
    const contentHash = hashContent(chunk.text);

    insertChunk(db, {
      id: chunkId,
      path: relativePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      text: chunk.text,
      hash: contentHash,
      embedding: embeddings[i],
    });
  }
}

/**
 * Compacts a daily memory file
 */
export async function compactDailyFile(
  db: Database.Database,
  memoryDir: string,
  date: string,
  mode: 'quick' | 'deep',
  llmConfig: LLMConfig | null,
  embeddingConfig: EmbeddingConfig,
  dryRun: boolean = false
): Promise<CompactionResult> {
  const result: CompactionResult = {
    originalEntries: 0,
    finalEntries: 0,
    removedDuplicates: 0,
    originalSizeKB: 0,
    finalSizeKB: 0,
    mode,
    errors: [],
  };

  const relativePath = path.join('memory', `${date}.md`);
  const filePath = path.join(memoryDir, relativePath);

  if (!fs.existsSync(filePath)) {
    result.errors.push(`File not found: ${relativePath}`);
    return result;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    result.originalSizeKB = Buffer.byteLength(content, 'utf-8') / 1024;

    const entries = parseMemoryFile(content);
    result.originalEntries = entries.length;

    if (entries.length === 0) {
      result.errors.push('No entries found in file');
      return result;
    }

    // Compact based on mode
    let compactedEntries: MemoryEntry[];
    if (mode === 'quick') {
      compactedEntries = quickCompact(entries);
    } else {
      if (!llmConfig) {
        result.errors.push('LLM config required for deep compaction');
        return result;
      }
      compactedEntries = await deepCompact(entries, llmConfig);
    }

    result.finalEntries = compactedEntries.length;
    result.removedDuplicates = result.originalEntries - result.finalEntries;

    if (!dryRun && result.removedDuplicates > 0) {
      // Reconstruct and write file
      const newContent = reconstructFile(date, compactedEntries);
      result.finalSizeKB = Buffer.byteLength(newContent, 'utf-8') / 1024;

      fs.writeFileSync(filePath, newContent, 'utf-8');

      // Re-index in database
      await reindexFile(db, filePath, relativePath, embeddingConfig);
    } else {
      result.finalSizeKB = result.originalSizeKB;
    }
  } catch (error) {
    result.errors.push(
      `Compaction failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return result;
}

/**
 * Identifies files that are candidates for compaction
 */
export function findCompactionCandidates(
  memoryDir: string,
  thresholdKB: number = 50,
  thresholdEntries: number = 30
): Array<{
  path: string;
  date: string;
  sizeKB: number;
  entryCount: number;
  reason: string;
}> {
  const dailyDir = path.join(memoryDir, 'memory');
  const candidates: Array<{
    path: string;
    date: string;
    sizeKB: number;
    entryCount: number;
    reason: string;
  }> = [];

  if (!fs.existsSync(dailyDir)) {
    return candidates;
  }

  const files = fs.readdirSync(dailyDir);

  for (const file of files) {
    if (!file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) continue;

    const filePath = path.join(dailyDir, file);
    const stats = fs.statSync(filePath);
    const sizeKB = stats.size / 1024;
    const date = file.replace('.md', '');

    const content = fs.readFileSync(filePath, 'utf-8');
    const entries = parseMemoryFile(content);
    const entryCount = entries.length;

    const reasons: string[] = [];
    if (sizeKB >= thresholdKB) {
      reasons.push(`size ${sizeKB.toFixed(1)}KB >= ${thresholdKB}KB`);
    }
    if (entryCount >= thresholdEntries) {
      reasons.push(`${entryCount} entries >= ${thresholdEntries}`);
    }

    if (reasons.length > 0) {
      candidates.push({
        path: path.join('memory', file),
        date,
        sizeKB,
        entryCount,
        reason: reasons.join(', '),
      });
    }
  }

  // Sort by size descending
  candidates.sort((a, b) => b.sizeKB - a.sizeKB);

  return candidates;
}

/**
 * Gets compaction statistics for a file without making changes
 */
export function getCompactionPreview(
  memoryDir: string,
  date: string
): {
  exists: boolean;
  sizeKB: number;
  entryCount: number;
  estimatedDuplicates: number;
} | null {
  const filePath = path.join(memoryDir, 'memory', `${date}.md`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const sizeKB = Buffer.byteLength(content, 'utf-8') / 1024;
  const entries = parseMemoryFile(content);

  // Estimate duplicates with quick compaction
  const compacted = quickCompact(entries);

  return {
    exists: true,
    sizeKB,
    entryCount: entries.length,
    estimatedDuplicates: entries.length - compacted.length,
  };
}
