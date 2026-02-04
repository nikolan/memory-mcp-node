import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  deleteChunksByPath,
  getChunkHashesByPath,
  deleteEmbeddingCacheByHashes,
} from './database.js';

export interface RetentionResult {
  deletedFiles: string[];
  deletedChunks: number;
  clearedCacheEntries: number;
  errors: string[];
}

/**
 * Parses a date from a daily file name (e.g., "2024-01-27.md" -> Date)
 */
function parseDateFromFilename(filename: string): Date | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!match) return null;
  const date = new Date(match[1] + 'T00:00:00');
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Calculates age in days from a date to now
 */
function getDaysOld(date: Date): number {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Scans memory directory and returns files exceeding the count limit (oldest first)
 */
export function findExpiredFiles(
  memoryDir: string,
  maxDailyChats: number
): Array<{ path: string; date: Date }> {
  const dailyDir = path.join(memoryDir, 'memory');

  if (!fs.existsSync(dailyDir)) {
    return [];
  }

  const files = fs.readdirSync(dailyDir);
  const validFiles: Array<{ path: string; date: Date }> = [];

  for (const file of files) {
    const fileDate = parseDateFromFilename(file);
    if (!fileDate) continue;

    validFiles.push({
      path: path.join('memory', file),
      date: fileDate
    });
  }

  // Sort by date, newest first to identify keepers
  validFiles.sort((a, b) => b.date.getTime() - a.date.getTime());

  // Files to delete are those after the first maxDailyChats
  const expiredFiles = validFiles.slice(maxDailyChats);

  // Sort expired files by date, oldest first (for reporting/deletion order)
  expiredFiles.sort((a, b) => a.date.getTime() - b.date.getTime());

  return expiredFiles;
}

/**
 * Enforces retention policy by keeping only the latest maxDailyChats files
 * Also cleans up associated database entries and embedding cache
 */
export function enforceRetention(
  db: Database.Database,
  memoryDir: string,
  maxDailyChats: number = 180,
  dryRun: boolean = false
): RetentionResult {
  const result: RetentionResult = {
    deletedFiles: [],
    deletedChunks: 0,
    clearedCacheEntries: 0,
    errors: [],
  };

  const expiredFiles = findExpiredFiles(memoryDir, maxDailyChats);

  for (const file of expiredFiles) {
    try {
      // Get chunk hashes before deleting (for cache cleanup)
      const hashes = getChunkHashesByPath(db, file.path);

      if (!dryRun) {
        // Delete from database
        const deletedCount = deleteChunksByPath(db, file.path);
        result.deletedChunks += deletedCount;

        // Clean up embedding cache
        if (hashes.length > 0) {
          deleteEmbeddingCacheByHashes(db, hashes);
          result.clearedCacheEntries += hashes.length;
        }

        // Delete the actual file
        const fullPath = path.join(memoryDir, file.path);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }

      result.deletedFiles.push(file.path);
    } catch (error) {
      result.errors.push(`Failed to delete ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

/**
 * Gets retention statistics without making changes
 */
export function getRetentionStats(
  memoryDir: string,
  maxDailyChats: number = 180
): {
  totalDailyFiles: number;
  expiredFiles: Array<{ path: string; date: Date }>;
  atCapacity: boolean;
} {
  const dailyDir = path.join(memoryDir, 'memory');

  if (!fs.existsSync(dailyDir)) {
    return {
      totalDailyFiles: 0,
      expiredFiles: [],
      atCapacity: false,
    };
  }

  const files = fs.readdirSync(dailyDir);
  let totalDailyFiles = 0;

  // Count valid daily files
  for (const file of files) {
    if (parseDateFromFilename(file)) {
      totalDailyFiles++;
    }
  }

  const expiredFiles = findExpiredFiles(memoryDir, maxDailyChats);

  return {
    totalDailyFiles,
    expiredFiles,
    atCapacity: totalDailyFiles >= maxDailyChats,
  };
}
