/**
 * File utilities for memory management.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Read a file, returning null if it doesn't exist.
 */
export function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Write a file, creating parent directories if needed.
 */
export function writeFileSafe(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, content, 'utf-8');
}

/**
 * Append to a file, creating it if needed.
 */
export function appendToFile(path: string, content: string): void {
  const existing = readFileSafe(path) ?? '';
  writeFileSafe(path, existing + content);
}

/**
 * Get today's date as YYYY-MM-DD.
 */
export function getTodayDate(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get current time as HH:MM.
 */
export function getCurrentTime(): string {
  return new Date().toTimeString().slice(0, 5);
}

/**
 * Get the daily memory file path for a given date.
 */
export function getDailyFilePath(memoryDir: string, date?: string): string {
  const d = date ?? getTodayDate();
  return join(memoryDir, 'memory', `${d}.md`);
}

/**
 * List all daily memory files in a directory.
 */
export function listDailyFiles(memoryDir: string): string[] {
  const dir = join(memoryDir, 'memory');
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse(); // Most recent first
}

/**
 * Read specific lines from a file (1-indexed).
 */
export function readLines(
  path: string,
  fromLine: number = 1,
  numLines: number = 15
): { text: string; totalLines: number } | null {
  const content = readFileSafe(path);
  if (content === null) return null;

  const lines = content.split('\n');
  const totalLines = lines.length;

  // Clamp values
  fromLine = Math.max(1, Math.min(fromLine, totalLines));
  const endLine = Math.min(fromLine + numLines - 1, totalLines);

  const selectedLines = lines.slice(fromLine - 1, endLine);

  return {
    text: selectedLines.join('\n'),
    totalLines
  };
}
