import Database from 'better-sqlite3';
import {
  getChunkCountSince,
  getLastMaintenanceRun,
  logMaintenanceRun,
  getChunksByCategory,
  markSupersedes,
} from './database.js';
import { enforceRetention, RetentionResult } from './retention.js';
import {
  compactDailyFile,
  findCompactionCandidates,
  getCompactionPreview,
  CompactionResult,
} from './compaction.js';
import {
  identifyPromotionCandidates,
  promoteToLongTerm,
  PromotionCandidate,
  PromotionResult,
  cleanupMemoryFile,
  CleanupResult,
  reindexMemoryFile,
  detectConflicts,
} from './promotion.js';
import { MaintenanceConfig, getMemoryFilePath } from './config.js';
import { createLLMConfig, type LLMConfig, type LLMProvider } from './llm.js';
import type { EmbeddingConfig } from './indexer.js';

export type MaintenanceAction = 'check' | 'full';

export interface MaintenanceStatus {
  overdue: boolean;
  overdueReasons: string[];
  lastRunAt: string | null;
  hoursSinceLast: number | null;
  writesSinceLast: number;
}

export interface MaintenanceSummary {
  action: MaintenanceAction;
  dryRun: boolean;
  status: MaintenanceStatus;
  retention?: RetentionResult & { expiredCount?: number };
  compaction?: {
    candidates: Array<{
      path: string;
      date: string;
      sizeKB: number;
      entryCount: number;
      reason: string;
      preview?: {
        estimatedDuplicates: number;
      };
    }>;
    processed: number;
    results?: CompactionResult[];
  };
  promotion?: {
    candidates?: PromotionCandidate[];
    totalAnalyzed?: number;
    result?: PromotionResult;
  };
  cleanup?: CleanupResult;
  notes?: string;
  errors: string[];
}

const DEFAULT_WRITE_THRESHOLD = 50;

function hoursBetween(fromIso: string, to: Date): number {
  const from = new Date(fromIso).getTime();
  const diffMs = to.getTime() - from;
  return diffMs / (1000 * 60 * 60);
}

export function getMaintenanceStatus(
  db: Database.Database,
  config: MaintenanceConfig,
  writeThreshold: number = DEFAULT_WRITE_THRESHOLD
): MaintenanceStatus {
  const lastRun = getLastMaintenanceRun(db);
  const now = new Date();

  let hoursSinceLast: number | null = null;
  let writesSinceLast = 0;
  const overdueReasons: string[] = [];

  if (lastRun) {
    hoursSinceLast = hoursBetween(lastRun.runAt, now);
    writesSinceLast = getChunkCountSince(db, lastRun.runAt);
  } else {
    writesSinceLast = getChunkCountSince(db, new Date(0).toISOString());
    overdueReasons.push('no prior maintenance run');
  }

  if (hoursSinceLast !== null && hoursSinceLast > config.autoMaintenanceIntervalHours) {
    overdueReasons.push(`last run ${hoursSinceLast.toFixed(1)}h ago`);
  }

  if (writesSinceLast > writeThreshold) {
    overdueReasons.push(`${writesSinceLast} writes since last run`);
  }

  return {
    overdue: overdueReasons.length > 0,
    overdueReasons,
    lastRunAt: lastRun ? lastRun.runAt : null,
    hoursSinceLast,
    writesSinceLast,
  };
}

export interface MaintenanceLLMOptions {
  embeddingConfig: EmbeddingConfig;
  llmProvider?: LLMProvider;
  openaiApiKey?: string;
  llmModel?: string;
}

export async function runMaintenance(
  db: Database.Database,
  memoryDir: string,
  config: MaintenanceConfig,
  action: MaintenanceAction,
  llmOptions: MaintenanceLLMOptions,
  dryRun: boolean = true
): Promise<MaintenanceSummary> {
  const status = getMaintenanceStatus(db, config);
  const errors: string[] = [];

  const summary: MaintenanceSummary = {
    action,
    dryRun,
    status,
    errors,
  };

  if (action === 'check') {
    return summary;
  }

  // Create LLM config for promotion and deep compaction
  let llmConfig: LLMConfig | null = null;
  try {
    if (llmOptions.openaiApiKey) {
      llmConfig = createLLMConfig(
        llmOptions.openaiApiKey,
        llmOptions.llmModel
      );
    }
  } catch {
    // LLM config not available - promotion and deep compaction will be skipped
  }

  try {
    // Full maintenance runs all tasks in optimal order:
    // 1. Retention (delete old files first)
    // 2. Compaction (deduplicate daily files)
    // 3. Promotion (move important content to MEMORY.md)
    // 4. Conflict detection (detect conflicts in promoted content)
    // 5. Cleanup (clean MEMORY.md and re-index)
    if (action === 'full') {
      // 1. Retention: Delete old daily files
      const retentionResult = enforceRetention(db, memoryDir, config.retentionDays, dryRun);
      summary.retention = {
        ...retentionResult,
        expiredCount: retentionResult.deletedFiles.length,
      };

      // 2. Compaction: Deduplicate daily files
      const candidates = findCompactionCandidates(
        memoryDir,
        config.compactionThresholdKB,
        config.compactionThresholdEntries
      );

      const compactionResults: CompactionResult[] = [];
      if (!dryRun) {
        for (const candidate of candidates) {
          const result = await compactDailyFile(
            db,
            memoryDir,
            candidate.date,
            config.compactionMode,
            llmConfig,
            llmOptions.embeddingConfig,
            false
          );
          compactionResults.push(result);
      }
      }

      summary.compaction = {
        candidates: candidates.map(candidate => ({
          ...candidate,
          preview: dryRun ? getCompactionPreview(memoryDir, candidate.date) || undefined : undefined,
        })),
        processed: dryRun ? 0 : compactionResults.length,
        results: dryRun ? undefined : compactionResults,
      };

      // 3. Promotion: Move important content to MEMORY.md (with conflict detection)
      if (!llmConfig) {
        errors.push('LLM configuration required for promotion. Set OPENAI_API_KEY.');
      } else if (dryRun) {
        const { candidates, totalAnalyzed } = await identifyPromotionCandidates(
          db,
          config.promotionLookbackDays,
          config.promotionScoreThreshold,
          llmConfig
        );
        summary.promotion = {
          candidates,
          totalAnalyzed,
        };
      } else {
        const result = await promoteToLongTerm(
          db,
          memoryDir,
          config.promotionLookbackDays,
          config.promotionScoreThreshold,
          llmConfig,
          llmOptions.embeddingConfig,
          false
        );
        summary.promotion = {
          result,
        };
      }

      // 4. Conflict detection: Detect and mark conflicts in MEMORY.md
      if (llmConfig) {
        // Get all chunks from MEMORY.md, sorted by creation date (newest first)
        const memoryChunks = getChunksByCategory(db, '', '').sort((a, b) => {
          // Sort by created_at if available, otherwise by ID
          const aInfo = db.prepare(`SELECT created_at FROM chunks WHERE id = ?`).get(a.id) as { created_at: string } | undefined;
          const bInfo = db.prepare(`SELECT created_at FROM chunks WHERE id = ?`).get(b.id) as { created_at: string } | undefined;
          if (aInfo?.created_at && bInfo?.created_at) {
            return new Date(bInfo.created_at).getTime() - new Date(aInfo.created_at).getTime();
          }
          return 0;
        });

        const detectedConflicts: Array<{
          newChunkId: string;
          oldChunkId: string;
          reason: 'updates' | 'corrects' | 'contradicts';
          confidence: number;
        }> = [];

        // Compare each newer chunk against older chunks
        for (let i = 0; i < memoryChunks.length; i++) {
          const newerChunk = memoryChunks[i];
          // Skip if already superseded
          const newerChunkInfo = db.prepare(`SELECT superseded_by FROM chunks WHERE id = ?`).get(newerChunk.id) as { superseded_by: string | null } | undefined;
          if (newerChunkInfo?.superseded_by) {
            continue;
          }

          // Get existing chunks (excluding current and already superseded)
          const existingChunks = memoryChunks.slice(i + 1).filter(c => {
            const info = db.prepare(`SELECT superseded_by FROM chunks WHERE id = ?`).get(c.id) as { superseded_by: string | null } | undefined;
            return !info?.superseded_by;
          });

          if (existingChunks.length === 0) {
            continue;
          }

          // Detect conflict using the detectConflicts function
          const conflict = await detectConflicts(
            db,
            newerChunk.text,
            newerChunk.id,
            '', // category - LLM will filter
            llmConfig
          );

          if (conflict.conflictsWith && conflict.confidence > 0.7) {
            detectedConflicts.push({
              newChunkId: newerChunk.id,
              oldChunkId: conflict.conflictsWith,
              reason: conflict.reason!,
              confidence: conflict.confidence,
            });
          }
        }

        if (!dryRun && detectedConflicts.length > 0) {
          // Mark supersession relationships
          for (const conflict of detectedConflicts) {
            markSupersedes(db, conflict.newChunkId, conflict.oldChunkId, conflict.reason);
          }
          summary.notes = (summary.notes ? summary.notes + '. ' : '') + `Detected and marked ${detectedConflicts.length} conflicts`;
        } else if (dryRun && detectedConflicts.length > 0) {
          summary.notes = (summary.notes ? summary.notes + '. ' : '') + `Would detect ${detectedConflicts.length} conflicts`;
        }
      }

      // 5. Cleanup: Clean MEMORY.md and re-index
      if (!dryRun) {
        const memoryFilePath = getMemoryFilePath(memoryDir);
        const cleanupResult = await cleanupMemoryFile(memoryFilePath);

        // Re-index MEMORY.md after cleanup to update database chunks
        try {
          await reindexMemoryFile(db, memoryFilePath, memoryDir, llmOptions.embeddingConfig);
        } catch (error) {
          errors.push(
            `Error re-indexing MEMORY.md after cleanup: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        summary.cleanup = cleanupResult;
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!dryRun) {
    const retentionDeleted = summary.retention?.deletedFiles.length || 0;
    const compactionProcessed = summary.compaction?.processed || 0;
    const promotionCount = summary.promotion?.result?.promoted.length || 0;
    logMaintenanceRun(
      db,
      retentionDeleted,
      compactionProcessed,
      promotionCount,
      `${action} run`
    );
  }

  return summary;
}
