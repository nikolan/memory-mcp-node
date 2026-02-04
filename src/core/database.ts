import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { writeFileSync, readFileSync } from 'fs';

export interface SearchResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  supersededBy?: string;
  supersedes?: string;
  conflictReason?: string;
}

interface ChunkInput {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embedding?: number[];
}

/**
 * Creates or opens a SQLite database connection
 */
export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  
  // Enable WAL mode for better concurrency with multiple connections
  db.pragma('journal_mode = WAL');
  
  // Set busy timeout to wait for locks instead of failing immediately
  db.pragma('busy_timeout = 5000');

  // Load sqlite-vec extension
  sqliteVec.load(db);

  return db;
}

/**
 * Embedding dimensions by provider
 */
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  voyage: 1024,
  local: 384,
};

/**
 * Initializes the database schema
 * @param embeddingDim - Dimension of embedding vectors (default: 384 for local)
 */
export function initSchema(db: Database.Database, embeddingDim: number = 384): void {
  // Create chunks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      promoted_at TEXT DEFAULT NULL,
      superseded_by TEXT DEFAULT NULL,
      supersedes TEXT DEFAULT NULL,
      conflict_reason TEXT DEFAULT NULL
    );
  `);

  // Create indexes for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
  `);

  // Create vector table using sqlite-vec
  // Check if table exists with different dimensions - recreate if needed
  const existingTable = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'
  `).get() as { sql: string } | undefined;
  
  if (existingTable) {
    const currentDim = existingTable.sql.match(/FLOAT\[(\d+)\]/)?.[1];
    if (currentDim && parseInt(currentDim) !== embeddingDim) {
      // Dimension mismatch - drop and recreate
      db.exec(`DROP TABLE IF EXISTS chunks_vec`);
    }
  }
  
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${embeddingDim}]
    );
  `);

  // Create FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content='chunks',
      content_rowid='rowid'
    );
  `);

  // Create embedding cache table
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash TEXT PRIMARY KEY,
      embedding BLOB NOT NULL
    );
  `);

  // Create maintenance log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_log (
      id INTEGER PRIMARY KEY,
      run_at TEXT NOT NULL,
      retention_deleted INTEGER DEFAULT 0,
      compaction_processed INTEGER DEFAULT 0,
      promotion_count INTEGER DEFAULT 0,
      notes TEXT
    );
  `);

  // Run migrations for existing databases
  runMigrations(db);
}

/**
 * Runs database migrations for existing databases
 */
function runMigrations(db: Database.Database): void {
  // Check if promoted_at column exists in chunks table
  const chunksInfo = db.prepare(`PRAGMA table_info(chunks)`).all() as Array<{ name: string }>;
  const hasPromotedAt = chunksInfo.some(col => col.name === 'promoted_at');
  const hasSupersededBy = chunksInfo.some(col => col.name === 'superseded_by');
  const hasSupersedes = chunksInfo.some(col => col.name === 'supersedes');
  const hasConflictReason = chunksInfo.some(col => col.name === 'conflict_reason');

  if (!hasPromotedAt) {
    db.exec(`ALTER TABLE chunks ADD COLUMN promoted_at TEXT DEFAULT NULL`);
  }

  if (!hasSupersededBy) {
    db.exec(`ALTER TABLE chunks ADD COLUMN superseded_by TEXT DEFAULT NULL`);
  }

  if (!hasSupersedes) {
    db.exec(`ALTER TABLE chunks ADD COLUMN supersedes TEXT DEFAULT NULL`);
  }

  if (!hasConflictReason) {
    db.exec(`ALTER TABLE chunks ADD COLUMN conflict_reason TEXT DEFAULT NULL`);
  }

  // Check if maintenance_log table exists (handled by CREATE IF NOT EXISTS above)
}

/**
 * Inserts a chunk into the database with optional embedding
 */
export function insertChunk(
  db: Database.Database,
  { id, path, startLine, endLine, text, hash, embedding }: ChunkInput
): void {
  const insertChunkStmt = db.prepare(`
    INSERT OR REPLACE INTO chunks (id, path, start_line, end_line, text, hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertVecStmt = db.prepare(`
    INSERT OR REPLACE INTO chunks_vec (id, embedding)
    VALUES (?, ?)
  `);

  const insertFtsStmt = db.prepare(`
    INSERT INTO chunks_fts (rowid, text)
    VALUES ((SELECT rowid FROM chunks WHERE id = ?), ?)
  `);

  // Transaction to ensure consistency
  const transaction = db.transaction(() => {
    // Insert into chunks table
    insertChunkStmt.run(id, path, startLine, endLine, text, hash);

    // Insert embedding if provided
    if (embedding && embedding.length > 0) {
      const embeddingBuffer = serializeEmbedding(embedding);
      insertVecStmt.run(id, embeddingBuffer);
    }

    // Insert into FTS table
    insertFtsStmt.run(id, text);
  });

  transaction();
}

/**
 * Deletes all chunks for a given file path
 */
export function deleteChunksByPath(db: Database.Database, path: string): number {
  const selectStmt = db.prepare(`SELECT id FROM chunks WHERE path = ?`);
  const deleteChunkStmt = db.prepare(`DELETE FROM chunks WHERE path = ?`);
  const deleteVecStmt = db.prepare(`DELETE FROM chunks_vec WHERE id = ?`);
  const deleteFtsStmt = db.prepare(`DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE id = ?)`);

  const transaction = db.transaction(() => {
    // Get all chunk IDs for this path
    const chunks = selectStmt.all(path) as Array<{ id: string }>;

    // Delete from vector table
    for (const chunk of chunks) {
      deleteVecStmt.run(chunk.id);
      deleteFtsStmt.run(chunk.id);
    }

    // Delete from chunks table
    const result = deleteChunkStmt.run(path);
    return result.changes;
  });

  return transaction();
}

/**
 * Performs vector similarity search
 */
export function vectorSearch(
  db: Database.Database,
  embedding: number[],
  limit: number = 10
): SearchResult[] {
  const embeddingBuffer = serializeEmbedding(embedding);

  const stmt = db.prepare(`
    SELECT
      cv.id,
      c.path,
      c.start_line,
      c.end_line,
      c.text,
      cv.distance
    FROM chunks_vec cv
    JOIN chunks c ON cv.id = c.id
    WHERE cv.embedding MATCH ? AND k = ${limit}
    ORDER BY cv.distance ASC
  `);

  const results = stmt.all(embeddingBuffer) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    distance: number;
  }>;

  return results.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    score: row.distance, // Distance from sqlite-vec (lower is better)
  }));
}

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
 * Performs BM25 full-text search
 */
export function bm25Search(
  db: Database.Database,
  query: string,
  limit: number = 10
): SearchResult[] {
  const escapedQuery = escapeFts5Query(query);

  const stmt = db.prepare(`
    SELECT
      c.id,
      c.path,
      c.start_line,
      c.end_line,
      c.text,
      fts.rank
    FROM chunks_fts fts
    JOIN chunks c ON fts.rowid = c.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY fts.rank DESC
    LIMIT ?
  `);

  const results = stmt.all(escapedQuery, limit) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  }>;

  return results.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    score: Math.abs(row.rank), // FTS rank is negative, convert to positive
  }));
}

/**
 * Retrieves a cached embedding by hash
 */
export function getCachedEmbedding(db: Database.Database, hash: string): number[] | null {
  const stmt = db.prepare(`
    SELECT embedding FROM embedding_cache WHERE hash = ?
  `);

  const row = stmt.get(hash) as { embedding: Buffer } | undefined;

  if (!row) {
    return null;
  }

  return deserializeEmbedding(row.embedding);
}

/**
 * Caches an embedding by hash
 */
export function cacheEmbedding(
  db: Database.Database,
  hash: string,
  embedding: number[]
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO embedding_cache (hash, embedding)
    VALUES (?, ?)
  `);

  const embeddingBuffer = serializeEmbedding(embedding);
  stmt.run(hash, embeddingBuffer);
}

/**
 * Gets the total number of chunks in the database
 */
export function getChunkCount(db: Database.Database): number {
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM chunks`);
  const result = stmt.get() as { count: number };
  return result.count;
}

/**
 * Gets all unique file paths in the database
 */
export function getAllPaths(db: Database.Database): string[] {
  const stmt = db.prepare(`
    SELECT DISTINCT path FROM chunks ORDER BY path
  `);

  const results = stmt.all() as Array<{ path: string }>;
  return results.map((row) => row.path);
}

/**
 * Serializes a number array to Float32Array buffer for storage in sqlite-vec
 */
function serializeEmbedding(embedding: number[]): Buffer {
  const float32Array = new Float32Array(embedding);
  return Buffer.from(float32Array.buffer);
}

/**
 * Deserializes a buffer back to a number array
 */
function deserializeEmbedding(buffer: Buffer): number[] {
  const float32Array = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
  return Array.from(float32Array);
}

/**
 * Closes the database connection
 */
export function closeDatabase(db: Database.Database): void {
  db.close();
}

/**
 * Gets a chunk by ID
 */
export function getChunkById(db: Database.Database, id: string): SearchResult | null {
  const stmt = db.prepare(`
    SELECT id, path, start_line, end_line, text FROM chunks WHERE id = ?
  `);

  const row = stmt.get(id) as {
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    score: 0, // No score for direct lookup
  };
}

/**
 * Gets chunks by file path
 */
export function getChunksByPath(db: Database.Database, path: string): SearchResult[] {
  const stmt = db.prepare(`
    SELECT id, path, start_line, end_line, text FROM chunks
    WHERE path = ?
    ORDER BY start_line ASC
  `);

  const results = stmt.all(path) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
  }>;

  return results.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    score: 0, // No score for direct lookup
  }));
}

/**
 * Deletes a specific chunk by ID
 */
export function deleteChunkById(db: Database.Database, id: string): number {
  const deleteChunkStmt = db.prepare(`DELETE FROM chunks WHERE id = ?`);
  const deleteVecStmt = db.prepare(`DELETE FROM chunks_vec WHERE id = ?`);
  const deleteFtsStmt = db.prepare(`DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE id = ?)`);

  const transaction = db.transaction(() => {
    deleteVecStmt.run(id);
    deleteFtsStmt.run(id);
    const result = deleteChunkStmt.run(id);
    return result.changes;
  });

  return transaction();
}

/**
 * Updates a chunk's embedding
 */
export function updateChunkEmbedding(
  db: Database.Database,
  id: string,
  embedding: number[]
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO chunks_vec (id, embedding)
    VALUES (?, ?)
  `);

  const embeddingBuffer = serializeEmbedding(embedding);
  stmt.run(id, embeddingBuffer);
}

/**
 * Clears all data from the database
 */
export function clearDatabase(db: Database.Database): void {
  const transaction = db.transaction(() => {
    db.exec(`DELETE FROM chunks_fts`);
    db.exec(`DELETE FROM chunks_vec`);
    db.exec(`DELETE FROM chunks`);
    db.exec(`DELETE FROM embedding_cache`);
  });

  transaction();
}

/**
 * Gets recent memories from the past N days
 */
export function getRecentMemories(
  db: Database.Database,
  sinceDate: string
): SearchResult[] {
  const stmt = db.prepare(`
    SELECT id, path, start_line, end_line, text, created_at
    FROM chunks
    WHERE created_at >= ?
    ORDER BY created_at DESC
  `);

  const results = stmt.all(sinceDate) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    created_at: string;
  }>;

  return results.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    score: 0,
  }));
}

/**
 * Gets memory system statistics
 */
export function getMemoryStats(db: Database.Database): {
  totalMemories: number;
  totalChunks: number;
  totalPaths: number;
} {
  const chunkCountStmt = db.prepare(`SELECT COUNT(*) as count FROM chunks`);
  const pathCountStmt = db.prepare(`SELECT COUNT(DISTINCT path) as count FROM chunks`);

  const chunkCount = (chunkCountStmt.get() as { count: number }).count;
  const pathCount = (pathCountStmt.get() as { count: number }).count;

  return {
    totalMemories: pathCount,
    totalChunks: chunkCount,
    totalPaths: pathCount,
  };
}

/**
 * Deletes a memory by file path (alias for deleteChunksByPath)
 */
export function deleteMemoryByPath(db: Database.Database, path: string): number {
  return deleteChunksByPath(db, path);
}

/**
 * Gets unpromoted chunks from daily files within a lookback period
 */
export function getUnpromotedChunks(
  db: Database.Database,
  lookbackDays: number
): Array<{
  id: string;
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  createdAt: string;
}> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

  const stmt = db.prepare(`
    SELECT id, path, text, start_line, end_line, created_at
    FROM chunks
    WHERE promoted_at IS NULL
      AND path LIKE 'memory/%'
      AND created_at >= ?
    ORDER BY created_at DESC
  `);

  const results = stmt.all(cutoffDate.toISOString()) as Array<{
    id: string;
    path: string;
    text: string;
    start_line: number;
    end_line: number;
    created_at: string;
  }>;

  return results.map(row => ({
    id: row.id,
    path: row.path,
    text: row.text,
    startLine: row.start_line,
    endLine: row.end_line,
    createdAt: row.created_at,
  }));
}

/**
 * Marks chunks as promoted
 */
export function markChunksAsPromoted(db: Database.Database, chunkIds: string[]): void {
  if (chunkIds.length === 0) return;

  const stmt = db.prepare(`UPDATE chunks SET promoted_at = ? WHERE id = ?`);
  const now = new Date().toISOString();

  const transaction = db.transaction(() => {
    for (const id of chunkIds) {
      stmt.run(now, id);
    }
  });

  transaction();
}

/**
 * Logs a maintenance run
 */
export function logMaintenanceRun(
  db: Database.Database,
  retentionDeleted: number,
  compactionProcessed: number,
  promotionCount: number,
  notes?: string
): void {
  const stmt = db.prepare(`
    INSERT INTO maintenance_log (run_at, retention_deleted, compaction_processed, promotion_count, notes)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(new Date().toISOString(), retentionDeleted, compactionProcessed, promotionCount, notes || null);
}

/**
 * Gets the last maintenance run
 */
export function getLastMaintenanceRun(db: Database.Database): {
  runAt: string;
  retentionDeleted: number;
  compactionProcessed: number;
  promotionCount: number;
  notes: string | null;
} | null {
  const stmt = db.prepare(`
    SELECT run_at, retention_deleted, compaction_processed, promotion_count, notes
    FROM maintenance_log
    ORDER BY id DESC
    LIMIT 1
  `);

  const row = stmt.get() as {
    run_at: string;
    retention_deleted: number;
    compaction_processed: number;
    promotion_count: number;
    notes: string | null;
  } | undefined;

  if (!row) return null;

  return {
    runAt: row.run_at,
    retentionDeleted: row.retention_deleted,
    compactionProcessed: row.compaction_processed,
    promotionCount: row.promotion_count,
    notes: row.notes,
  };
}

/**
 * Gets the count of chunks written since a given date
 */
export function getChunkCountSince(db: Database.Database, sinceDate: string): number {
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM chunks WHERE created_at >= ?`);
  const result = stmt.get(sinceDate) as { count: number };
  return result.count;
}

/**
 * Deletes embedding cache entries by their hashes
 */
export function deleteEmbeddingCacheByHashes(db: Database.Database, hashes: string[]): void {
  if (hashes.length === 0) return;

  const stmt = db.prepare(`DELETE FROM embedding_cache WHERE hash = ?`);

  const transaction = db.transaction(() => {
    for (const hash of hashes) {
      stmt.run(hash);
    }
  });

  transaction();
}

/**
 * Gets all daily file paths with their chunk counts and sizes
 */
export function getDailyFileStats(db: Database.Database): Array<{
  path: string;
  chunkCount: number;
  totalTextLength: number;
}> {
  const stmt = db.prepare(`
    SELECT path, COUNT(*) as chunk_count, SUM(LENGTH(text)) as total_text_length
    FROM chunks
    WHERE path LIKE 'memory/%'
    GROUP BY path
    ORDER BY path DESC
  `);

  const results = stmt.all() as Array<{
    path: string;
    chunk_count: number;
    total_text_length: number;
  }>;

  return results.map(row => ({
    path: row.path,
    chunkCount: row.chunk_count,
    totalTextLength: row.total_text_length,
  }));
}

/**
 * Gets chunk hashes for a given path (for embedding cache cleanup)
 */
export function getChunkHashesByPath(db: Database.Database, path: string): string[] {
  const stmt = db.prepare(`SELECT hash FROM chunks WHERE path = ?`);
  const results = stmt.all(path) as Array<{ hash: string }>;
  return results.map(row => row.hash);
}

/**
 * Marks a chunk as superseded by another chunk
 */
export function markSupersedes(
  db: Database.Database,
  newChunkId: string,
  oldChunkId: string,
  reason: 'updates' | 'corrects' | 'contradicts'
): void {
  const stmt = db.prepare(`
    UPDATE chunks
    SET superseded_by = ?, supersedes = ?, conflict_reason = ?
    WHERE id IN (?, ?)
  `);

  // Mark old chunk as superseded
  db.prepare(`UPDATE chunks SET superseded_by = ?, conflict_reason = ? WHERE id = ?`).run(
    newChunkId,
    reason,
    oldChunkId
  );

  // Mark new chunk as superseding
  db.prepare(`UPDATE chunks SET supersedes = ?, conflict_reason = ? WHERE id = ?`).run(
    oldChunkId,
    reason,
    newChunkId
  );
}

/**
 * Gets chunks from MEMORY.md in the same category for conflict detection
 */
export function getChunksByCategory(
  db: Database.Database,
  category: string,
  excludeChunkId?: string
): Array<{
  id: string;
  text: string;
  path: string;
}> {
  // Extract category from path or use a heuristic
  // For now, we'll get all chunks from MEMORY.md and filter by category later
  // This is a simplified approach - in practice, we might want to store category in DB
  const stmt = db.prepare(`
    SELECT id, text, path
    FROM chunks
    WHERE path = 'MEMORY.md'
      AND id != COALESCE(?, '')
      AND superseded_by IS NULL
    ORDER BY created_at DESC
  `);

  const results = stmt.all(excludeChunkId || '') as Array<{
    id: string;
    text: string;
    path: string;
  }>;

  return results;
}
