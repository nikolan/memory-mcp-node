import * as fs from 'fs';
import * as path from 'path';
import type { DistributedConfig } from './config.js';

/**
 * Sync configuration derived from distributed config
 */
export interface SyncConfig {
  centralUrl?: string;
  apiKey?: string;
  engineerId?: string;
}

/**
 * Sync state tracking
 */
export interface SyncState {
  lastPush?: string;
  lastPull?: string;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  success: boolean;
  count: number;
  message: string;
}

/**
 * Sync status information
 */
export interface SyncStatus {
  configured: boolean;
  distributed: boolean;
  centralUrl?: string;
  engineerId?: string;
  lastPush?: string;
  lastPull?: string;
}

const SYNC_STATE_FILE = '.sync-state.json';

/**
 * Get sync state file path
 */
function getSyncStatePath(memoryDir: string): string {
  return path.join(memoryDir, SYNC_STATE_FILE);
}

/**
 * Read sync state from disk
 */
export function readSyncState(memoryDir: string): SyncState {
  const statePath = getSyncStatePath(memoryDir);
  if (!fs.existsSync(statePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write sync state to disk
 */
export function writeSyncState(memoryDir: string, state: SyncState): void {
  const statePath = getSyncStatePath(memoryDir);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Create SyncConfig from DistributedConfig
 */
export function createSyncConfig(distributed: DistributedConfig): SyncConfig {
  return {
    centralUrl: distributed.centralUrl,
    apiKey: distributed.apiKey,
    engineerId: distributed.engineerId,
  };
}

/**
 * Push local memories to central server
 * 
 * Phase 2 implementation - currently a stub
 */
export async function pushToRemote(
  memoryDir: string,
  config: SyncConfig
): Promise<SyncResult> {
  if (!config.centralUrl) {
    return {
      success: false,
      count: 0,
      message: 'Remote sync not configured. Set MEMORY_CENTRAL_URL to enable.',
    };
  }

  // Phase 2: Implement actual push logic
  // - Read unsynced chunks from local database
  // - Generate embeddings if needed
  // - POST to central API
  // - Update sync state

  return {
    success: false,
    count: 0,
    message: 'Push not implemented - coming in Phase 2. Central URL: ' + config.centralUrl,
  };
}

/**
 * Pull team knowledge from central server to local
 * 
 * Phase 2 implementation - currently a stub
 */
export async function pullFromRemote(
  memoryDir: string,
  config: SyncConfig
): Promise<SyncResult> {
  if (!config.centralUrl) {
    return {
      success: false,
      count: 0,
      message: 'Remote sync not configured. Set MEMORY_CENTRAL_URL to enable.',
    };
  }

  // Phase 2: Implement actual pull logic
  // - GET from central API with since timestamp
  // - Write team memories to team/ folder
  // - Re-index team folder
  // - Update sync state

  return {
    success: false,
    count: 0,
    message: 'Pull not implemented - coming in Phase 2. Central URL: ' + config.centralUrl,
  };
}

/**
 * Get current sync status
 */
export function getSyncStatus(
  memoryDir: string,
  distributed: DistributedConfig
): SyncStatus {
  const state = readSyncState(memoryDir);
  
  return {
    configured: !!distributed.centralUrl,
    distributed: distributed.enabled,
    centralUrl: distributed.centralUrl,
    engineerId: distributed.engineerId,
    lastPush: state.lastPush,
    lastPull: state.lastPull,
  };
}
