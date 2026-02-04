import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  createDatabase,
  initSchema,
  insertChunk,
  markSupersedes,
  getChunkById,
  closeDatabase,
} from '../dist/core/database.js';
import { hybridSearch } from '../dist/core/search.js';
import { formatSearchResults } from '../dist/core/formatter.js';
import { generateEmbeddings } from '../dist/core/indexer.js';

test('supersedes: markSupersedes creates bidirectional relationship', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = createDatabase(dbPath);
  initSchema(db, 384);

  try {
    // Insert two chunks
    insertChunk(db, {
      id: 'chunk-old',
      path: 'MEMORY.md',
      startLine: 1,
      endLine: 5,
      text: 'Uses npm for package management',
      hash: 'hash1',
      embedding: new Array(384).fill(0.1),
    });

    insertChunk(db, {
      id: 'chunk-new',
      path: 'MEMORY.md',
      startLine: 6,
      endLine: 10,
      text: 'Switched to pnpm - faster installs, better monorepo support',
      hash: 'hash2',
      embedding: new Array(384).fill(0.2),
    });

    // Mark supersession relationship
    markSupersedes(db, 'chunk-new', 'chunk-old', 'updates');

    // Verify old chunk is marked as superseded
    const oldChunk = db.prepare(`
      SELECT superseded_by, conflict_reason FROM chunks WHERE id = ?
    `).get('chunk-old');
    
    assert.equal(oldChunk.superseded_by, 'chunk-new');
    assert.equal(oldChunk.conflict_reason, 'updates');

    // Verify new chunk marks the old one as superseded
    const newChunk = db.prepare(`
      SELECT supersedes, conflict_reason FROM chunks WHERE id = ?
    `).get('chunk-new');
    
    assert.equal(newChunk.supersedes, 'chunk-old');
    assert.equal(newChunk.conflict_reason, 'updates');
  } finally {
    closeDatabase(db);
    await fs.rm(tmpDir, { recursive: true });
  }
});

test('supersedes: search results include conflict metadata', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = createDatabase(dbPath);
  initSchema(db, 384);

  try {
    // Insert chunks with conflict relationship
    insertChunk(db, {
      id: 'chunk-old',
      path: 'MEMORY.md',
      startLine: 1,
      endLine: 5,
      text: 'Uses npm for package management',
      hash: 'hash1',
      embedding: new Array(384).fill(0.1),
    });

    insertChunk(db, {
      id: 'chunk-new',
      path: 'MEMORY.md',
      startLine: 6,
      endLine: 10,
      text: 'Switched to pnpm - faster installs, better monorepo support',
      hash: 'hash2',
      embedding: new Array(384).fill(0.2),
    });

    // Mark supersession
    markSupersedes(db, 'chunk-new', 'chunk-old', 'updates');

    // Generate query embedding
    const [queryEmbedding] = await generateEmbeddings(
      ['package manager'],
      { provider: 'local', apiKey: '', model: '' }
    );

    // Search for package manager
    const results = await hybridSearch(db, 'package manager', queryEmbedding, {
      maxResults: 10,
      minScore: 0.1,
    });

    // Find the old chunk in results
    const oldResult = results.find(r => r.id === 'chunk-old');
    assert.ok(oldResult, 'old chunk should be in results');
    assert.equal(oldResult.supersededBy, 'chunk-new');
    assert.equal(oldResult.conflictReason, 'updates');

    // Find the new chunk in results
    const newResult = results.find(r => r.id === 'chunk-new');
    assert.ok(newResult, 'new chunk should be in results');
    assert.equal(newResult.supersedes, 'chunk-old');
    assert.equal(newResult.conflictReason, 'updates');
  } finally {
    closeDatabase(db);
    await fs.rm(tmpDir, { recursive: true });
  }
});

test('supersedes: formatter shows conflict warnings', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = createDatabase(dbPath);
  initSchema(db, 384);

  try {
    // Insert chunks
    insertChunk(db, {
      id: 'chunk-old',
      path: 'MEMORY.md',
      startLine: 1,
      endLine: 5,
      text: 'Uses npm for package management',
      hash: 'hash1',
      embedding: new Array(384).fill(0.1),
    });

    insertChunk(db, {
      id: 'chunk-new',
      path: 'MEMORY.md',
      startLine: 6,
      endLine: 10,
      text: 'Switched to pnpm',
      hash: 'hash2',
      embedding: new Array(384).fill(0.2),
    });

    markSupersedes(db, 'chunk-new', 'chunk-old', 'updates');

    // Generate query embedding
    const [queryEmbedding] = await generateEmbeddings(
      ['package manager'],
      { provider: 'local', apiKey: '', model: '' }
    );

    const results = await hybridSearch(db, 'package manager', queryEmbedding, {
      maxResults: 10,
      minScore: 0.1,
    });

    // Format results
    const formatted = formatSearchResults(
      results.map(r => ({
        content: r.text,
        score: r.score,
        path: r.path,
        lineStart: r.startLine,
        lineEnd: r.endLine,
        supersededBy: r.supersededBy,
        supersedes: r.supersedes,
        conflictReason: r.conflictReason,
      }))
    );

    // Check that warnings are present
    // Look for the old chunk by its content
    const oldChunkFormatted = formatted.split('\n').find(line => line.includes('npm'));
    assert.ok(oldChunkFormatted, 'old chunk should be formatted');
    assert.ok(oldChunkFormatted.includes('⚠️ SUPERSEDED'), 'should show superseded warning');

    // Look for the new chunk by its content
    const newChunkFormatted = formatted.split('\n').find(line => line.includes('pnpm'));
    assert.ok(newChunkFormatted, 'new chunk should be formatted');
    assert.ok(newChunkFormatted.includes('✓ Updates older entry'), 'should show updates indicator');
  } finally {
    closeDatabase(db);
    await fs.rm(tmpDir, { recursive: true });
  }
});

test('supersedes: migration adds columns to existing database', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = createDatabase(dbPath);
  
  // Create table without new columns (simulating old schema)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      promoted_at TEXT DEFAULT NULL
    );
  `);

  // Insert a chunk
  db.prepare(`
    INSERT INTO chunks (id, path, start_line, end_line, text, hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('chunk-1', 'MEMORY.md', 1, 5, 'Test content', 'hash1');

  // Now run initSchema which should add the new columns
  initSchema(db, 384);

  // Verify columns exist
  const columns = db.prepare(`PRAGMA table_info(chunks)`).all();
  const columnNames = columns.map(c => c.name);

  assert.ok(columnNames.includes('superseded_by'), 'superseded_by column should exist');
  assert.ok(columnNames.includes('supersedes'), 'supersedes column should exist');
  assert.ok(columnNames.includes('conflict_reason'), 'conflict_reason column should exist');

  // Verify we can use the new columns
  db.prepare(`
    UPDATE chunks SET superseded_by = ?, conflict_reason = ? WHERE id = ?
  `).run('chunk-2', 'updates', 'chunk-1');

  const result = db.prepare(`SELECT superseded_by, conflict_reason FROM chunks WHERE id = ?`).get('chunk-1');
  assert.equal(result.superseded_by, 'chunk-2');
  assert.equal(result.conflict_reason, 'updates');

  closeDatabase(db);
  await fs.rm(tmpDir, { recursive: true });
});

test('supersedes: getChunkById returns conflict metadata', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = createDatabase(dbPath);
  initSchema(db, 384);

  try {
    insertChunk(db, {
      id: 'chunk-1',
      path: 'MEMORY.md',
      startLine: 1,
      endLine: 5,
      text: 'Old content',
      hash: 'hash1',
      embedding: new Array(384).fill(0.1),
    });

    markSupersedes(db, 'chunk-2', 'chunk-1', 'corrects');

    // Get chunk directly from database to verify metadata
    const chunk = db.prepare(`
      SELECT id, superseded_by, supersedes, conflict_reason FROM chunks WHERE id = ?
    `).get('chunk-1');

    assert.equal(chunk.superseded_by, 'chunk-2');
    assert.equal(chunk.conflict_reason, 'corrects');
  } finally {
    closeDatabase(db);
    await fs.rm(tmpDir, { recursive: true });
  }
});
