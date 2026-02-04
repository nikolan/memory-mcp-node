import type Database from 'better-sqlite3';
import { jaccardSimilarity } from './textUtils.js';

interface SearchResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  vectorScore: number;
  bm25Score: number;
  supersededBy?: string;
  supersedes?: string;
  conflictReason?: string;
}

interface SearchOptions {
  maxResults?: number;  // default 6
  minScore?: number;    // default 0.35
  vectorWeight?: number; // default 0.7
  bm25Weight?: number;   // default 0.3
}

// Constants for scoring
const DEFAULT_OPTIONS: Required<SearchOptions> = {
  maxResults: 6,
  minScore: 0.35,
  vectorWeight: 0.7,
  bm25Weight: 0.3,
};

/**
 * Escape a query string for FTS5
 * Wraps each token in double quotes to treat special characters as literals
 */
function escapeFts5Query(query: string): string {
  return query
    .split(/\s+/)
    .filter(token => token.length > 0)
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

/**
 * Convert vector distance to similarity score
 * Uses formula: 1 / (1 + distance)
 */
function distanceToSimilarity(distance: number): number {
  return 1 / (1 + Math.abs(distance));
}

/**
 * Normalize BM25 score from SQLite
 * SQLite returns negative values where more negative = better
 * This normalizes to 0-1 range where higher is better
 */
function normalizeBm25Score(sqliteBm25: number): number {
  // SQLite bm25() returns negative values
  // We normalize by using exponential decay based on how negative it is
  // More negative (worse) scores -> closer to 0
  // Less negative (better) scores -> closer to 1
  return Math.max(0, 1 + sqliteBm25 / 100); // Divide by 100 to scale appropriately
}

/**
 * Vector-only search using vector embeddings
 * Returns top results sorted by vector similarity
 */
export function vectorOnlySearch(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number
): SearchResult[] {
  const embeddingBuffer = Buffer.from(new Float32Array(queryEmbedding).buffer);

  const stmt = db.prepare(`
    SELECT
      cv.id,
      c.path,
      c.start_line as startLine,
      c.end_line as endLine,
      c.text,
      cv.distance as vectorDistance,
      c.superseded_by as supersededBy,
      c.supersedes,
      c.conflict_reason as conflictReason
    FROM chunks_vec cv
    JOIN chunks c ON cv.id = c.id
    WHERE cv.embedding MATCH ? AND k = ${limit}
    ORDER BY cv.distance ASC
  `);

  const rows = stmt.all(embeddingBuffer) as Array<{
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    text: string;
    vectorDistance: number;
    supersededBy: string | null;
    supersedes: string | null;
    conflictReason: string | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    text: row.text,
    vectorScore: distanceToSimilarity(row.vectorDistance),
    bm25Score: 0,
    score: distanceToSimilarity(row.vectorDistance),
    supersededBy: row.supersededBy || undefined,
    supersedes: row.supersedes || undefined,
    conflictReason: row.conflictReason || undefined,
  }));
}

/**
 * Keyword-only search using BM25 full-text search
 * Returns top results sorted by BM25 relevance
 */
export function keywordOnlySearch(
  db: Database.Database,
  query: string,
  limit: number
): SearchResult[] {
  const escapedQuery = escapeFts5Query(query);

  const stmt = db.prepare(`
    SELECT
      c.id,
      c.path,
      c.start_line as startLine,
      c.end_line as endLine,
      c.text,
      bm25(chunks_fts, 100, 5, 1) as bm25_score,
      c.superseded_by as supersededBy,
      c.supersedes,
      c.conflict_reason as conflictReason
    FROM chunks_fts
    JOIN chunks c ON chunks_fts.rowid = c.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY bm25(chunks_fts, 100, 5, 1) ASC
    LIMIT ?
  `);

  const rows = stmt.all(escapedQuery, limit) as Array<{
    id: string;
    path: string;
    startLine: number;
    endLine: number;
    text: string;
    bm25_score: number;
    supersededBy: string | null;
    supersedes: string | null;
    conflictReason: string | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    text: row.text,
    bm25Score: normalizeBm25Score(row.bm25_score),
    vectorScore: 0,
    score: normalizeBm25Score(row.bm25_score),
    supersededBy: row.supersededBy || undefined,
    supersedes: row.supersedes || undefined,
    conflictReason: row.conflictReason || undefined,
  }));
}

/**
 * Deduplicate search results by removing near-identical chunks.
 * Keeps the higher-scoring result when duplicates are found.
 * Results must be sorted by score (descending) before calling.
 */
function deduplicateResults(
  results: SearchResult[],
  threshold: number = 0.7
): SearchResult[] {
  const kept: SearchResult[] = [];

  for (const result of results) {
    const isDuplicate = kept.some(
      k => jaccardSimilarity(k.text, result.text) > threshold
    );
    if (!isDuplicate) {
      kept.push(result);
    }
  }

  return kept;
}

/**
 * Hybrid search combining vector similarity and BM25 keyword matching
 *
 * Algorithm:
 * 1. Run vector search and BM25 search in parallel (fetch 3x maxResults each)
 * 2. Merge results by chunk ID
 * 3. Calculate combined score: vectorWeight * vectorScore + bm25Weight * bm25Score
 * 4. Sort by combined score descending
 * 5. Deduplicate near-identical results
 * 6. Filter by minScore
 * 7. Return top maxResults
 */
export async function hybridSearch(
  db: Database.Database,
  query: string,
  queryEmbedding: number[],
  options?: SearchOptions
): Promise<SearchResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const fetchLimit = opts.maxResults * 3;

  // Run vector and BM25 searches in parallel
  const [vectorResults, bm25Results] = await Promise.all([
    Promise.resolve(vectorOnlySearch(db, queryEmbedding, fetchLimit)),
    Promise.resolve(keywordOnlySearch(db, query, fetchLimit)),
  ]);

  // Merge results by chunk ID
  const resultMap = new Map<string, SearchResult>();

  // Add vector results
  for (const result of vectorResults) {
    resultMap.set(result.id, result);
  }

  // Merge BM25 results
  for (const result of bm25Results) {
    const existing = resultMap.get(result.id);
    if (existing) {
      // Combine scores for duplicate entries
      existing.bm25Score = result.bm25Score;
      existing.score =
        opts.vectorWeight * existing.vectorScore +
        opts.bm25Weight * existing.bm25Score;
      // Preserve conflict metadata from whichever result has it
      if (result.supersededBy) existing.supersededBy = result.supersededBy;
      if (result.supersedes) existing.supersedes = result.supersedes;
      if (result.conflictReason) existing.conflictReason = result.conflictReason;
    } else {
      resultMap.set(result.id, result);
    }
  }

  // Convert map to array and sort by combined score
  const mergedResults = Array.from(resultMap.values());

  // For results that only have one type of score, calculate the combined score
  for (const result of mergedResults) {
    if (result.vectorScore === 0 && result.bm25Score > 0) {
      // Only BM25 score
      result.score = opts.bm25Weight * result.bm25Score;
    } else if (result.bm25Score === 0 && result.vectorScore > 0) {
      // Only vector score
      result.score = opts.vectorWeight * result.vectorScore;
    } else if (result.vectorScore > 0 && result.bm25Score > 0) {
      // Both scores
      result.score =
        opts.vectorWeight * result.vectorScore +
        opts.bm25Weight * result.bm25Score;
    }
  }

  // Sort by score descending
  const sorted = mergedResults.sort((a, b) => b.score - a.score);

  // Deduplicate near-identical results
  const deduplicated = deduplicateResults(sorted, 0.7);

  // Filter by minScore and return top maxResults
  return deduplicated
    .filter(result => result.score >= opts.minScore)
    .slice(0, opts.maxResults);
}
