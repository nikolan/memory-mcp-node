import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createDatabase,
  initSchema,
  insertChunk,
  closeDatabase,
} from '../dist/core/database.js';
import { keywordOnlySearch } from '../dist/core/search.js';

test('FTS5 search handles dashes in query (memory-mcp-node)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-mcp-search-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = createDatabase(dbPath);
  initSchema(db);

  try {
    insertChunk(db, {
      id: 'chunk-1',
      path: 'memory/test.md',
      startLine: 1,
      endLine: 5,
      text: 'Working on the memory-mcp-node project for AI assistants',
      hash: 'hash1',
    });

    insertChunk(db, {
      id: 'chunk-2',
      path: 'memory/test.md',
      startLine: 6,
      endLine: 10,
      text: 'This is unrelated content about cooking recipes',
      hash: 'hash2',
    });

    // This query would fail before the fix with "no such column: mcp"
    const results = keywordOnlySearch(db, 'memory-mcp-node', 10);

    assert.ok(results.length > 0, 'should find results for dashed query');
    assert.equal(results[0].id, 'chunk-1', 'should match the correct chunk');
  } finally {
    closeDatabase(db);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('FTS5 search handles multiple dashes and special chars', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-mcp-search-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = createDatabase(dbPath);
  initSchema(db);

  try {
    insertChunk(db, {
      id: 'chunk-1',
      path: 'memory/test.md',
      startLine: 1,
      endLine: 5,
      text: 'Using @anthropic-ai/sdk for the claude-code-assistant project',
      hash: 'hash1',
    });

    // Test various problematic queries
    const queries = [
      '@anthropic-ai/sdk',
      'claude-code-assistant',
      'anthropic-ai',
    ];

    for (const query of queries) {
      // Should not throw
      const results = keywordOnlySearch(db, query, 10);
      assert.ok(Array.isArray(results), `query "${query}" should not throw`);
    }
  } finally {
    closeDatabase(db);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('FTS5 search handles quotes in query', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-mcp-search-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = createDatabase(dbPath);
  initSchema(db);

  try {
    insertChunk(db, {
      id: 'chunk-1',
      path: 'memory/test.md',
      startLine: 1,
      endLine: 5,
      text: 'User said "hello world" in the conversation',
      hash: 'hash1',
    });

    // Query with quotes - should be escaped properly
    const results = keywordOnlySearch(db, 'said "hello"', 10);
    assert.ok(Array.isArray(results), 'query with quotes should not throw');
  } finally {
    closeDatabase(db);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('FTS5 search still matches content correctly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-mcp-search-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = createDatabase(dbPath);
  initSchema(db);

  try {
    insertChunk(db, {
      id: 'chunk-1',
      path: 'memory/test.md',
      startLine: 1,
      endLine: 5,
      text: 'TypeScript preferences for the memory-mcp-node project',
      hash: 'hash1',
    });

    insertChunk(db, {
      id: 'chunk-2',
      path: 'memory/other.md',
      startLine: 1,
      endLine: 5,
      text: 'Python preferences for data science work',
      hash: 'hash2',
    });

    // Simple query should still work
    const tsResults = keywordOnlySearch(db, 'TypeScript', 10);
    assert.ok(tsResults.length > 0, 'should find TypeScript');
    assert.equal(tsResults[0].id, 'chunk-1');

    const pyResults = keywordOnlySearch(db, 'Python', 10);
    assert.ok(pyResults.length > 0, 'should find Python');
    assert.equal(pyResults[0].id, 'chunk-2');

    // Multi-word query
    const multiResults = keywordOnlySearch(db, 'memory project', 10);
    assert.ok(multiResults.length > 0, 'multi-word query should work');
  } finally {
    closeDatabase(db);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
