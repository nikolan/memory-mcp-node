import OpenAI from 'openai';

export type LLMProvider = 'openai';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
}

export interface LLMResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_MODEL = 'gpt-4o-mini';

export async function callLLM(
  config: LLMConfig,
  prompt: string,
  options?: LLMOptions
): Promise<LLMResponse> {
  const client = new OpenAI({ apiKey: config.apiKey });

  try {
    const response = await client.chat.completions.create({
      model: config.model || DEFAULT_MODEL,
      max_tokens: options?.maxTokens ?? 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    return {
      content: response.choices[0]?.message?.content?.trim() || '',
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      },
    };
  } catch (error) {
    throw new Error(
      `OpenAI API error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function createLLMConfig(
  openaiApiKey?: string,
  model?: string
): LLMConfig {
  if (!openaiApiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable.');
  }

  return {
    provider: 'openai',
    apiKey: openaiApiKey,
    model,
  };
}
