/**
 * LLM-optimized formatting for memory retrieval
 * Transforms human-readable storage into compact token-efficient format
 */

/**
 * Compact a markdown string for LLM consumption
 * - Strips markdown headers (#, ##, ###)
 * - Collapses multiple newlines to single space
 * - Collapses whitespace
 * - Removes trailing/leading whitespace
 */
export function compactText(text: string): string {
  return text
    // Remove markdown headers
    .replace(/^#+\s+/gm, '')
    // Collapse multiple newlines to space
    .replace(/\n\n+/g, ' ')
    // Collapse single newlines to space
    .replace(/\n/g, ' ')
    // Collapse multiple spaces to single space
    .replace(/\s+/g, ' ')
    // Trim
    .trim();
}

/**
 * Format search result for LLM consumption
 * Compact pipe-delimited format: path|score|text
 */
export function formatSearchResult(result: {
  content: string;
  score: number;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  supersededBy?: string;
  supersedes?: string;
  conflictReason?: string;
}): string {
  const compactContent = compactText(result.content);
  const scoreStr = result.score.toFixed(2);
  let prefix = `[${scoreStr}]`;
  
  // Add conflict indicators
  if (result.supersededBy) {
    prefix += ` ⚠️ SUPERSEDED`;
  } else if (result.supersedes) {
    prefix += ` ✓ Updates older entry`;
  }
  
  return `${prefix} ${result.path}: ${compactContent}`;
}

/**
 * Format recent memory for LLM consumption
 * Compact pipe-delimited format: path|text
 */
export function formatRecentMemory(memory: {
  content: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}): string {
  const compactContent = compactText(memory.content);
  return `${memory.path}: ${compactContent}`;
}

/**
 * Format memory_search response for LLM
 * Returns newline-separated compact records with scores
 */
export function formatSearchResults(results: Array<{
  content: string;
  score: number;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  supersededBy?: string;
  supersedes?: string;
  conflictReason?: string;
}>): string {
  if (results.length === 0) {
    return '';
  }
  return results
    .map(formatSearchResult)
    .join('\n');
}

/**
 * Format memory_list_recent response for LLM
 * Returns newline-separated compact records
 */
export function formatRecentMemories(memories: Array<{
  content: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}>): string {
  if (memories.length === 0) {
    return '';
  }
  return memories
    .map(formatRecentMemory)
    .join('\n');
}

/**
 * Format memory_get response for LLM
 * Returns compact text with minimal metadata
 */
export function formatMemoryGet(content: string, path: string, lineInfo?: { fromLine: number; toLine: number; totalLines: number }): string {
  const compact = compactText(content);
  if (lineInfo) {
    return `${path} (lines ${lineInfo.fromLine}-${lineInfo.toLine}/${lineInfo.totalLines}): ${compact}`;
  }
  return `${path}: ${compact}`;
}
