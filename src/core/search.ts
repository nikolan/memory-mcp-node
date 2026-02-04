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

// RRF constant - controls how quickly rank contribution decays
const RRF_K = 60;

// Bonus for top-ranked results (creates decisive confidence gaps)
const TOP_RANK_BONUS = 0.05;

/**
 * Hybrid search combining vector similarity and BM25 keyword matching
 *
 * Algorithm (RRF + Top-Rank Bonus):
 * 1. Run vector search and BM25 search in parallel (fetch 3x maxResults each)
 * 2. Build rank maps for each search type
 * 3. Calculate RRF score: 1/(k+rank_vector) + 1/(k+rank_bm25)
 * 4. Add bonus for #1 rank in either search (+0.05 each)
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

  // Build rank maps (1-indexed ranks)
  const vectorRankMap = new Map<string, number>();
  const bm25RankMap = new Map<string, number>();

  vectorResults.forEach((r, i) => vectorRankMap.set(r.id, i + 1));
  bm25Results.forEach((r, i) => bm25RankMap.set(r.id, i + 1));

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
      // Preserve BM25 score and conflict metadata
      existing.bm25Score = result.bm25Score;
      if (result.supersededBy) existing.supersededBy = result.supersededBy;
      if (result.supersedes) existing.supersedes = result.supersedes;
      if (result.conflictReason) existing.conflictReason = result.conflictReason;
    } else {
      resultMap.set(result.id, result);
    }
  }

  // Calculate RRF scores with Top-Rank Bonus
  const mergedResults = Array.from(resultMap.values());

  for (const result of mergedResults) {
    const vectorRank = vectorRankMap.get(result.id);
    const bm25Rank = bm25RankMap.get(result.id);

    // RRF: 1/(k+rank) for each search type, 0 if not present
    const rrfVector = vectorRank ? 1 / (RRF_K + vectorRank) : 0;
    const rrfBm25 = bm25Rank ? 1 / (RRF_K + bm25Rank) : 0;

    let score = rrfVector + rrfBm25;

    // Top-Rank Bonus: +0.05 for being #1 in either search
    if (vectorRank === 1) score += TOP_RANK_BONUS;
    if (bm25Rank === 1) score += TOP_RANK_BONUS;

    result.score = score;
  }

  // Sort by RRF score descending
  const sorted = mergedResults.sort((a, b) => b.score - a.score);

  // Deduplicate near-identical results
  const deduplicated = deduplicateResults(sorted, 0.7);

  // Filter by minScore and return top maxResults
  // Note: RRF scores are typically smaller (0.01-0.15 range), so we scale minScore
  const scaledMinScore = opts.minScore * 0.1; // 0.35 -> 0.035
  return deduplicated
    .filter(result => result.score >= scaledMinScore)
    .slice(0, opts.maxResults);
}
