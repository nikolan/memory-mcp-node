import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

import type { LLMProvider } from './llm.js';
import type { EmbeddingProvider } from './indexer.js';

export interface DistributedConfig {
  enabled: boolean;
  centralUrl?: string;
  apiKey?: string;
  engineerId?: string;
  autoSync?: boolean;
}

export interface Config {
  memoryDir: string;
  embeddingModel: string;
  maxDailyChats: number;
  maintenance: MaintenanceConfig;
  retentionDays: number;

  openaiApiKey?: string;
  voyageApiKey?: string;

  embeddingProvider: EmbeddingProvider;
  llmProvider?: LLMProvider;
  llmModel?: string;

  distributed: DistributedConfig;
}

export interface MaintenanceConfig {
  retentionDays: number;
  compactionThresholdKB: number;
  compactionThresholdEntries: number;
  compactionMode: 'quick' | 'deep';
  promotionScoreThreshold: number;
  promotionLookbackDays: number;
  autoMaintenanceIntervalHours: number;
}

const DEFAULT_MEMORY_DIR = path.join(homedir(), '.memory-mcp');
const CONFIG_FILE = path.join(DEFAULT_MEMORY_DIR, 'config.json');
const ENV_FILE = path.join(DEFAULT_MEMORY_DIR, '.env');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const PROJECT_CONFIG_FILE = path.join(PROJECT_ROOT, 'config.json');

const DEFAULT_DISTRIBUTED: DistributedConfig = {
  enabled: false,
  autoSync: true,
};

const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, string> = {
  voyage: 'voyage-3-lite',
  local: 'Xenova/all-MiniLM-L6-v2',
};

const BASE_DEFAULTS: Omit<Config, 'embeddingProvider' | 'llmProvider'> = {
  memoryDir: DEFAULT_MEMORY_DIR,
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  maxDailyChats: 180,
  retentionDays: 180,
  maintenance: {
    retentionDays: 180,
    compactionThresholdKB: 10,
    compactionThresholdEntries: 10,
    compactionMode: 'quick',
    promotionScoreThreshold: 0.8,
    promotionLookbackDays: 30,
    autoMaintenanceIntervalHours: 24,
  },
  distributed: DEFAULT_DISTRIBUTED,
};

let loadedDefaults = { ...BASE_DEFAULTS };
try {
  if (fs.existsSync(PROJECT_CONFIG_FILE)) {
    const data = JSON.parse(fs.readFileSync(PROJECT_CONFIG_FILE, 'utf-8'));
    loadedDefaults = {
      ...loadedDefaults,
      ...data,
      maintenance: {
        ...loadedDefaults.maintenance,
        ...(data.maintenance || {})
      }
    };
  }
} catch (e) {
  // Ignore errors reading project config
}

const DEFAULT_CONFIG = loadedDefaults;

const INITIAL_MEMORY_TEMPLATE = `# Memory

This file stores important information about you, your preferences, decisions, and contacts.

## User Preferences

Add information about your preferences here. Examples:
- Communication style preferences
- Work hours and timezone
- Preferred tools and workflows
- Learning style preferences

## Important Decisions

Record significant decisions you've made:
- Project decisions
- Career choices
- Personal commitments
- Policy or process decisions

## Key Contacts

Important people and their contact information:
- Name: [Full Name]
- Role: [Their role/relationship]
- Contact: [Email/Phone]
- Notes: [Any relevant information]
`;

export function getConfigDir(): string {
  return DEFAULT_MEMORY_DIR;
}

export function getDefaultMemoryDir(): string {
  return DEFAULT_MEMORY_DIR;
}

export function getDatabasePath(memoryDir: string): string {
  return path.join(memoryDir, 'index.sqlite');
}

export function getMemoryFilePath(memoryDir: string): string {
  return path.join(memoryDir, 'MEMORY.md');
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export function hasValidConfig(): boolean {
  return true;
}

export function loadEnv(): void {
  // No-op: env vars are expected to be set by the environment
  // (shell profile, Claude Code apiKeyHelper, etc.)
}

export function getConfig(): Config {
  let fileConfig: Record<string, unknown> = {};
  if (configExists()) {
    try {
      const configData = fs.readFileSync(CONFIG_FILE, 'utf-8');
      fileConfig = JSON.parse(configData);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in config file: ${error.message}`);
      }
      throw error;
    }
  }

  const openaiApiKey = (fileConfig.openaiApiKey as string) || process.env.OPENAI_API_KEY;
  const voyageApiKey = (fileConfig.voyageApiKey as string) || process.env.VOYAGE_API_KEY;

  const hasOpenai = !!openaiApiKey;
  const hasVoyage = !!voyageApiKey;

  // Embedding: voyage if key exists, otherwise local
  const embeddingProviderEnv = process.env.EMBEDDING_PROVIDER as EmbeddingProvider | undefined;
  let embeddingProvider: EmbeddingProvider;
  
  if (embeddingProviderEnv && (embeddingProviderEnv === 'voyage' || embeddingProviderEnv === 'local')) {
    embeddingProvider = embeddingProviderEnv;
  } else if (fileConfig.embeddingProvider === 'voyage' || fileConfig.embeddingProvider === 'local') {
    embeddingProvider = fileConfig.embeddingProvider as EmbeddingProvider;
  } else if (hasVoyage) {
    embeddingProvider = 'voyage';
  } else {
    embeddingProvider = 'local';
  }

  if (embeddingProvider === 'voyage' && !hasVoyage) {
    throw new Error('VOYAGE_API_KEY required for Voyage embeddings');
  }

  // LLM: openai if key exists, otherwise undefined
  let llmProvider: LLMProvider | undefined;
  if (hasOpenai) {
    llmProvider = 'openai';
  }

  const memoryDir = (fileConfig.memoryDir as string) || DEFAULT_CONFIG.memoryDir;

  const maintenanceFromFile = (fileConfig.maintenance as Partial<MaintenanceConfig>) || {};
  const parseNumberEnv = (value: string | undefined, fallback: number): number => {
    if (value === undefined || value === '') {
      return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const maxDailyChats = parseNumberEnv(
    process.env.MEMORY_MAX_DAILY_CHATS,
    (fileConfig.maxDailyChats as number) ?? DEFAULT_CONFIG.maxDailyChats ?? DEFAULT_CONFIG.retentionDays
  );

  const retentionDays = parseNumberEnv(
    process.env.MEMORY_RETENTION_DAYS,
    (fileConfig.retentionDays as number) ?? maxDailyChats ?? DEFAULT_CONFIG.retentionDays
  );

  const maintenance: MaintenanceConfig = {
    ...DEFAULT_CONFIG.maintenance,
    ...maintenanceFromFile,
    retentionDays,
    compactionThresholdKB: parseNumberEnv(process.env.MEMORY_COMPACTION_THRESHOLD_KB, maintenanceFromFile.compactionThresholdKB ?? DEFAULT_CONFIG.maintenance.compactionThresholdKB),
    compactionThresholdEntries: parseNumberEnv(process.env.MEMORY_COMPACTION_THRESHOLD_ENTRIES, maintenanceFromFile.compactionThresholdEntries ?? DEFAULT_CONFIG.maintenance.compactionThresholdEntries),
    compactionMode: (process.env.MEMORY_COMPACTION_MODE as 'quick' | 'deep') || maintenanceFromFile.compactionMode || DEFAULT_CONFIG.maintenance.compactionMode,
    promotionScoreThreshold: parseNumberEnv(process.env.MEMORY_PROMOTION_SCORE_THRESHOLD, maintenanceFromFile.promotionScoreThreshold ?? DEFAULT_CONFIG.maintenance.promotionScoreThreshold),
    promotionLookbackDays: parseNumberEnv(process.env.MEMORY_PROMOTION_LOOKBACK_DAYS, maintenanceFromFile.promotionLookbackDays ?? DEFAULT_CONFIG.maintenance.promotionLookbackDays),
    autoMaintenanceIntervalHours: parseNumberEnv(process.env.MEMORY_AUTO_MAINTENANCE_INTERVAL_HOURS, maintenanceFromFile.autoMaintenanceIntervalHours ?? DEFAULT_CONFIG.maintenance.autoMaintenanceIntervalHours),
  };

  const llmModel = (fileConfig.llmModel as string) || process.env.LLM_MODEL;

  const distributedFromFile = (fileConfig.distributed as Partial<DistributedConfig>) || {};
  const distributed: DistributedConfig = {
    enabled: process.env.MEMORY_DISTRIBUTED === 'true' || distributedFromFile.enabled || DEFAULT_DISTRIBUTED.enabled,
    centralUrl: process.env.MEMORY_CENTRAL_URL || distributedFromFile.centralUrl,
    apiKey: process.env.MEMORY_CENTRAL_API_KEY || distributedFromFile.apiKey,
    engineerId: process.env.MEMORY_ENGINEER_ID || distributedFromFile.engineerId,
    autoSync: distributedFromFile.autoSync ?? DEFAULT_DISTRIBUTED.autoSync,
  };

  const embeddingModel = (fileConfig.embeddingModel as string) ||
    process.env.EMBEDDING_MODEL ||
    DEFAULT_EMBEDDING_MODELS[embeddingProvider];

  const config: Config = {
    memoryDir,
    embeddingModel,
    maxDailyChats,
    retentionDays,
    maintenance,
    openaiApiKey,
    voyageApiKey,
    embeddingProvider,
    llmProvider,
    llmModel,
    distributed,
  };

  return config;
}

export function saveConfig(config: Partial<Config>): void {
  try {
    if (!fs.existsSync(DEFAULT_MEMORY_DIR)) {
      fs.mkdirSync(DEFAULT_MEMORY_DIR, { recursive: true });
    }

    let existingConfig: Record<string, unknown> = {};
    if (configExists()) {
      const configData = fs.readFileSync(CONFIG_FILE, 'utf-8');
      existingConfig = JSON.parse(configData);
    }

    const merged = {
      ...existingConfig,
      ...config,
    };

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in existing config file: ${error.message}`);
    }
    throw error;
  }
}

function formatEnvValue(value: string): string {
  const needsQuotes = /[\s#]/.test(value);
  if (!needsQuotes) {
    return value;
  }
  const escaped = value.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function upsertEnvFile(content: string, updates: Record<string, string>): string {
  const lines = content.split(/\r?\n/);
  const seen = new Set<string>();
  const output: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match) {
      output.push(line);
      continue;
    }
    const key = match[1];
    if (key in updates) {
      output.push(`${key}=${formatEnvValue(updates[key])}`);
      seen.add(key);
    } else {
      output.push(line);
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      output.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  return output.join('\n').replace(/\s*$/, '') + '\n';
}

export function saveEnvConfigAtPath(config: Partial<Config>, envPath: string): void {
  try {
    const envDir = path.dirname(envPath);
    if (!fs.existsSync(envDir)) {
      fs.mkdirSync(envDir, { recursive: true });
    }

    const updates: Record<string, string> = {};
    if (config.openaiApiKey) {
      updates.OPENAI_API_KEY = config.openaiApiKey;
    }
    if (config.voyageApiKey) {
      updates.VOYAGE_API_KEY = config.voyageApiKey;
    }

    if (Object.keys(updates).length === 0) {
      return;
    }

    const existing = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, 'utf-8')
      : '';

    const updated = upsertEnvFile(existing, updates);
    fs.writeFileSync(envPath, updated, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write .env config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveEnvConfig(config: Partial<Config>): void {
  saveEnvConfigAtPath(config, ENV_FILE);
}

export function getEnvFilePath(): string {
  return ENV_FILE;
}

export function ensureMemoryDir(memoryDir: string): void {
  try {
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    const memoryFile = getMemoryFilePath(memoryDir);
    if (!fs.existsSync(memoryFile)) {
      fs.writeFileSync(memoryFile, INITIAL_MEMORY_TEMPLATE, 'utf-8');
    }

    const memorySubDir = path.join(memoryDir, 'memory');
    if (!fs.existsSync(memorySubDir)) {
      fs.mkdirSync(memorySubDir, { recursive: true });
    }

    const teamSubDir = path.join(memoryDir, 'team');
    if (!fs.existsSync(teamSubDir)) {
      fs.mkdirSync(teamSubDir, { recursive: true });
    }
  } catch (error) {
    throw new Error(`Failed to ensure memory directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateConfig(config: Config): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.memoryDir || config.memoryDir.trim() === '') {
    errors.push('memoryDir is required and cannot be empty');
  }

  if (!config.embeddingModel || config.embeddingModel.trim() === '') {
    errors.push('embeddingModel is required and cannot be empty');
  }

  if (config.embeddingProvider === 'voyage' && !config.voyageApiKey) {
    errors.push('voyageApiKey required for Voyage embeddings');
  }

  if (config.llmProvider === 'openai' && !config.openaiApiKey) {
    errors.push('openaiApiKey required for OpenAI LLM');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function getEmbeddingApiKey(config: Config): string | undefined {
  if (config.embeddingProvider === 'local') {
    return undefined;
  }
  if (config.embeddingProvider === 'voyage') {
    if (!config.voyageApiKey) {
      throw new Error('voyageApiKey required for Voyage embeddings');
    }
    return config.voyageApiKey;
  }
  return undefined;
}

export function getConfigWithDefaults(): Config {
  const config = getConfig();
  return {
    memoryDir: config.memoryDir || DEFAULT_CONFIG.memoryDir,
    embeddingModel: config.embeddingModel || DEFAULT_EMBEDDING_MODELS[config.embeddingProvider],
    maxDailyChats: Number.isFinite(config.maxDailyChats)
      ? config.maxDailyChats
      : DEFAULT_CONFIG.maxDailyChats,
    retentionDays: config.retentionDays || DEFAULT_CONFIG.retentionDays,
    maintenance: {
      ...DEFAULT_CONFIG.maintenance,
      ...config.maintenance,
    },
    openaiApiKey: config.openaiApiKey,
    voyageApiKey: config.voyageApiKey,
    embeddingProvider: config.embeddingProvider,
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
    distributed: {
      ...DEFAULT_DISTRIBUTED,
      ...config.distributed,
    },
  };
}

export function resetConfig(): void {
  try {
    const currentConfig = configExists() ? getConfig() : null;

    const resetConfig = {
      ...DEFAULT_CONFIG,
      ...(currentConfig && { openaiApiKey: currentConfig.openaiApiKey }),
    };

    saveConfig(resetConfig);
  } catch (error) {
    throw new Error(`Failed to reset config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createConfigDirectory(): void {
  if (!fs.existsSync(DEFAULT_MEMORY_DIR)) {
    fs.mkdirSync(DEFAULT_MEMORY_DIR, { recursive: true });
  }
}

export function createMemoryTemplate(memoryDir: string = DEFAULT_MEMORY_DIR): void {
  const memoryFile = getMemoryFilePath(memoryDir);
  if (!fs.existsSync(memoryFile)) {
    fs.writeFileSync(memoryFile, INITIAL_MEMORY_TEMPLATE, 'utf-8');
  }
}
