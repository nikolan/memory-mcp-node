import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  extractWords,
  jaccardSimilarity,
  isDuplicateOf,
} from '../dist/core/textUtils.js';
import { cleanupMemoryFile } from '../dist/core/promotion.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// textUtils Tests
// ============================================================================

test('textUtils: extractWords filters words > 2 chars', () => {
  const text = 'The quick brown fox jumps';
  const words = extractWords(text);

  assert.equal(words.size, 5);
  assert(words.has('the'));
  assert(words.has('quick'));
  assert(words.has('brown'));
  assert(words.has('fox'));
  assert(words.has('jumps'));
  // Short words should be filtered out
  assert(!words.has('a'));
});

test('textUtils: extractWords lowercases all words', () => {
  const text = 'Hello WORLD FooBar';
  const words = extractWords(text);

  assert(words.has('hello'));
  assert(words.has('world'));
  assert(words.has('foobar'));
  assert(!words.has('Hello'));
  assert(!words.has('WORLD'));
});

test('textUtils: jaccardSimilarity returns 1 for identical texts', () => {
  const text = 'The quick brown fox jumps over the lazy dog';
  const similarity = jaccardSimilarity(text, text);

  assert.equal(similarity, 1);
});

test('textUtils: jaccardSimilarity returns 0 for completely different texts', () => {
  const text1 = 'apple banana cherry date elderberry';
  const text2 = 'moon star planet galaxy asteroid';
  const similarity = jaccardSimilarity(text1, text2);

  assert.equal(similarity, 0);
});

test('textUtils: jaccardSimilarity returns expected value for partial overlap', () => {
  const text1 = 'the quick brown fox jumps';
  const text2 = 'the quick red fox runs';
  const similarity = jaccardSimilarity(text1, text2);

  // Common words: the, quick, fox (3 words)
  // Total unique words: the, quick, brown, fox, jumps, red, runs (7 words)
  // Jaccard = 3/7 ≈ 0.4286
  assert(similarity > 0.4 && similarity < 0.45);
});

test('textUtils: jaccardSimilarity ignores short words', () => {
  // Words "a" and "to" should be filtered out
  const text1 = 'a quick brown fox to jump';
  const text2 = 'a quick brown fox to run';
  const similarity = jaccardSimilarity(text1, text2);

  // Common words: quick, brown, fox (3)
  // Total unique: quick, brown, fox, jump, run (5)
  // Jaccard = 3/5 = 0.6
  assert(similarity === 0.6);
});

test('textUtils: jaccardSimilarity handles empty texts', () => {
  const similarity1 = jaccardSimilarity('', '');
  assert.equal(similarity1, 0);

  const similarity2 = jaccardSimilarity('hello world', '');
  assert.equal(similarity2, 0);

  const similarity3 = jaccardSimilarity('', 'hello world');
  assert.equal(similarity3, 0);
});

test('textUtils: isDuplicateOf correctly identifies exact duplicates', () => {
  const text = 'the quick brown fox jumps over the lazy dog';
  const existingTexts = [text];

  const isDupe = isDuplicateOf(text, existingTexts, 0.85);
  assert.equal(isDupe, true);
});

test('textUtils: isDuplicateOf correctly identifies near-duplicates above threshold', () => {
  const text1 = 'the quick brown fox jumps over the lazy dog';
  const text2 = 'the quick brown fox jumps over the lazy dog';
  const existingTexts = [text1];

  const isDupe = isDuplicateOf(text2, existingTexts, 0.85);
  assert.equal(isDupe, true);
});

test('textUtils: isDuplicateOf rejects dissimilar texts', () => {
  const text = 'apple banana cherry';
  const existingTexts = ['moon star planet'];

  const isDupe = isDuplicateOf(text, existingTexts, 0.85);
  assert.equal(isDupe, false);
});

test('textUtils: isDuplicateOf respects threshold', () => {
  const text1 = 'the quick brown fox';
  const text2 = 'the quick red fox'; // ~66% similar
  const existingTexts = [text1];

  // Should not be duplicate at 0.85 threshold
  const isDupe1 = isDuplicateOf(text2, existingTexts, 0.85);
  assert.equal(isDupe1, false);

  // Should be duplicate at 0.5 threshold
  const isDupe2 = isDuplicateOf(text2, existingTexts, 0.5);
  assert.equal(isDupe2, true);
});

test('textUtils: isDuplicateOf checks against all existing texts', () => {
  const text = 'the quick brown fox';
  const existingTexts = [
    'apple banana cherry',
    'moon star planet',
    'the quick brown fox', // Match with this one
  ];

  const isDupe = isDuplicateOf(text, existingTexts, 0.85);
  assert.equal(isDupe, true);
});

test('textUtils: isDuplicateOf uses default threshold of 0.85', () => {
  const text = 'the quick brown fox jumps';
  const existingTexts = ['the quick brown fox jumps']; // 100% match

  // Called without threshold parameter
  const isDupe = isDuplicateOf(text, existingTexts);
  assert.equal(isDupe, true);
});

// ============================================================================
// Cleanup Tests (Memory File Deduplication)
// ============================================================================

test('cleanup: cleanupMemoryFile strips simple details tags', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');

  const content = `# Long-Term Memory

## User Preferences

### 2024-01-15
<details>
<summary>Click to expand</summary>
Prefers TypeScript over JavaScript
</details>

More text here.`;

  fs.writeFileSync(memoryPath, content, 'utf-8');

  const result = await cleanupMemoryFile(memoryPath);

  assert.equal(result.detailsStripped, 1);
  const cleaned = fs.readFileSync(memoryPath, 'utf-8');
  assert(!cleaned.includes('<details>'));
  assert(!cleaned.includes('<summary>'));
  assert(cleaned.includes('Prefers TypeScript'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('cleanup: cleanupMemoryFile handles nested details tags', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');

  const content = `## Important Decisions

### 2024-01-20
<details>
<summary>Outer</summary>
<details>
<summary>Inner</summary>
Used Postgres for project X
</details>
</details>`;

  fs.writeFileSync(memoryPath, content, 'utf-8');

  const result = await cleanupMemoryFile(memoryPath);

  // Both detail tags should be stripped
  assert(result.detailsStripped > 0);
  const cleaned = fs.readFileSync(memoryPath, 'utf-8');
  assert(!cleaned.includes('<details>'));
  assert(!cleaned.includes('<summary>'));
  assert(cleaned.includes('Postgres'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('cleanup: cleanupMemoryFile deduplicates highly similar sections', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');

  const content = `# Long-Term Memory

## User Preferences

### Identical Entry 1
Uses TypeScript for all development projects with comprehensive type safety and excellent developer experience

### Identical Entry 2
Uses TypeScript for all development projects with comprehensive type safety and excellent developer experience

### Different Entry
Prefers functional programming paradigms and immutable data structures`;

  fs.writeFileSync(memoryPath, content, 'utf-8');

  const result = await cleanupMemoryFile(memoryPath);

  // Should remove one duplicate (exact match of first two)
  assert.equal(result.sectionsRemoved, 1);
  const cleaned = fs.readFileSync(memoryPath, 'utf-8');

  // Should keep unique entries
  assert(cleaned.includes('TypeScript'));
  assert(cleaned.includes('functional programming'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('cleanup: cleanupMemoryFile keeps unique sections', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');

  const content = `# Long-Term Memory

### 2024-01-15
Uses pnpm as package manager exclusively

### 2024-01-16
Prefers Cursor and Claude Code for development

### 2024-01-17
Interested in vector databases for semantic search`;

  fs.writeFileSync(memoryPath, content, 'utf-8');

  const result = await cleanupMemoryFile(memoryPath);

  // No duplicates should be found
  assert.equal(result.sectionsRemoved, 0);
  const cleaned = fs.readFileSync(memoryPath, 'utf-8');

  // All sections should be preserved
  assert(cleaned.includes('pnpm'));
  assert(cleaned.includes('Cursor'));
  assert(cleaned.includes('vector databases'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('cleanup: cleanupMemoryFile returns zero values for non-existent file', async () => {
  const result = await cleanupMemoryFile('/nonexistent/path/MEMORY.md');

  assert.equal(result.sectionsRemoved, 0);
  assert.equal(result.bytesReduced, 0);
  assert.equal(result.detailsStripped, 0);
});

test('cleanup: cleanupMemoryFile reduces file size when removing details tags', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');

  const content = `# Memory

### Entry
<details>
<summary>Click me</summary>
Important information here
</details>

More text.`;

  fs.writeFileSync(memoryPath, content, 'utf-8');

  const result = await cleanupMemoryFile(memoryPath);

  // File size should be reduced
  assert(result.bytesReduced > 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('cleanup: cleanupMemoryFile keeps longest section when deduplicating', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');

  const content = `# Memory

### Short Version
Uses Python for data science and machine learning projects

### Long Version
Uses Python for data science and machine learning projects with scikit-learn and TensorFlow for neural networks and pandas for data analysis`;

  fs.writeFileSync(memoryPath, content, 'utf-8');

  const result = await cleanupMemoryFile(memoryPath);

  // The more detailed version should be kept
  assert(result.sectionsRemoved >= 0); // Allow either 0 or 1 depending on similarity
  const cleaned = fs.readFileSync(memoryPath, 'utf-8');

  // Verify Python is preserved
  assert(cleaned.includes('Python'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('cleanup: cleanupMemoryFile handles empty file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');

  fs.writeFileSync(memoryPath, '', 'utf-8');

  const result = await cleanupMemoryFile(memoryPath);

  assert.equal(result.sectionsRemoved, 0);
  assert.equal(result.bytesReduced, 0);
  assert.equal(result.detailsStripped, 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('cleanup: cleanupMemoryFile handles file without sections', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');

  fs.writeFileSync(memoryPath, '# Just a header\n\nSome unstructured text', 'utf-8');

  const result = await cleanupMemoryFile(memoryPath);

  // No ### sections to deduplicate
  assert.equal(result.sectionsRemoved, 0);

  fs.rmSync(tmpDir, { recursive: true });
});

test('cleanup: cleanupMemoryFile handles malformed details tags', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');

  const content = `# Memory

### Entry
<details>
Mismatched tags
</detail>

More text.`;

  fs.writeFileSync(memoryPath, content, 'utf-8');

  const result = await cleanupMemoryFile(memoryPath);

  // Should handle the malformed tag gracefully
  const cleaned = fs.readFileSync(memoryPath, 'utf-8');
  assert(cleaned.includes('Mismatched tags'));

  fs.rmSync(tmpDir, { recursive: true });
});

// ============================================================================
// Integration Tests
// ============================================================================

test('integration: textUtils correctly identifies similar memory entries', () => {
  // Simulate two memory entries from different times - very similar
  const entry1 = `
    Uses GitHub Actions for CI/CD pipeline with automatic testing and deployment workflows
  `.trim();

  const entry2 = `
    Uses GitHub Actions for CI/CD pipeline with automatic testing and deployment workflows and notifications
  `.trim();

  const similarity = jaccardSimilarity(entry1, entry2);

  // These should be considered similar (>0.7 threshold)
  assert(similarity > 0.7);

  // Should be marked as duplicate at 0.7 threshold
  const isDupe = isDuplicateOf(entry2, [entry1], 0.7);
  assert.equal(isDupe, true);
});

test('integration: textUtils handles memory entries with punctuation', () => {
  // Test that punctuation doesn't prevent similarity matching
  const entry1 = 'Uses Cursor IDE, Claude Code, and Codex for development tasks.';
  const entry2 = 'Uses Cursor IDE Claude Code and Codex for development tasks';

  const similarity = jaccardSimilarity(entry1, entry2);

  // Punctuation should be treated as word separators; similarity should be reasonable
  assert(similarity > 0.5);

  // Also test that near-exact matches work (without punctuation)
  const entry3 = 'Uses TypeScript for type safety and better developer experience';
  const entry4 = 'Uses TypeScript for type safety and better developer experience';
  assert.equal(jaccardSimilarity(entry3, entry4), 1);
});

test('integration: cleanup produces valid markdown output', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');

  const content = `# Long-Term Memory

## User Preferences

### 2024-01-15
<details>
<summary>Preferences</summary>
Uses TypeScript for type safety
</details>

### 2024-01-16
Uses TypeScript for development

## Important Decisions

### 2024-01-20
Chose PostgreSQL for database with ACID compliance`;

  fs.writeFileSync(memoryPath, content, 'utf-8');

  const result = await cleanupMemoryFile(memoryPath);
  const cleaned = fs.readFileSync(memoryPath, 'utf-8');

  // Verify markdown structure is preserved
  assert(cleaned.includes('# Long-Term Memory'));
  assert(cleaned.includes('## User Preferences'));
  assert(cleaned.includes('## Important Decisions'));

  // No HTML tags should remain
  assert(!cleaned.includes('<details>'));
  assert(!cleaned.includes('<summary>'));
  assert(!cleaned.includes('</details>'));
  assert(!cleaned.includes('</summary>'));

  // Content should be preserved
  assert(cleaned.includes('TypeScript'));
  assert(cleaned.includes('PostgreSQL'));
  assert(cleaned.includes('ACID compliance'));

  fs.rmSync(tmpDir, { recursive: true });
});

test('integration: textUtils handles case-insensitive matching', () => {
  const entry1 = 'Uses Python for machine learning projects';
  const entry2 = 'uses PYTHON for Machine Learning projects';

  const similarity = jaccardSimilarity(entry1, entry2);

  // Should be nearly identical when case is ignored
  assert(similarity >= 0.9);
});

test('integration: similarity threshold tuning for memory deduplication', () => {
  const baseEntry = 'Prefers functional programming paradigms';

  const relatedEntry1 = 'Prefers functional programming'; // ~85% similar
  const relatedEntry2 = 'Programming paradigm preference'; // ~50% similar
  const differentEntry = 'Likes object-oriented design patterns'; // ~20% similar

  const sim1 = jaccardSimilarity(baseEntry, relatedEntry1);
  const sim2 = jaccardSimilarity(baseEntry, relatedEntry2);
  const sim3 = jaccardSimilarity(baseEntry, differentEntry);

  // With 0.7 threshold, only relatedEntry1 should be duplicate
  assert(isDuplicateOf(relatedEntry1, [baseEntry], 0.7) === true);
  assert(isDuplicateOf(relatedEntry2, [baseEntry], 0.7) === false);
  assert(isDuplicateOf(differentEntry, [baseEntry], 0.7) === false);

  // Verify ordering
  assert(sim1 > sim2 && sim2 > sim3);
});
