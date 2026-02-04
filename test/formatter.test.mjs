import assert from 'assert';
import { test } from 'node:test';
import {
  compactText,
  formatSearchResult,
  formatRecentMemory,
  formatSearchResults,
  formatRecentMemories,
  formatMemoryGet
} from '../dist/core/formatter.js';

test('formatter - compactText removes markdown headers', () => {
  const input = '# Header\n## Subheader\n### Subsubheader\nText here';
  const result = compactText(input);
  assert(!result.includes('#'));
  assert(result.includes('Header'));
  assert(result.includes('Text here'));
});

test('formatter - compactText collapses whitespace', () => {
  const input = 'Text with\n\nmultiple\n\n\nnewlines and   spaces';
  const result = compactText(input);
  assert.equal(result, 'Text with multiple newlines and spaces');
});

test('formatter - compactText trims result', () => {
  const input = '  \n  Text here  \n  ';
  const result = compactText(input);
  assert.equal(result, 'Text here');
});

test('formatter - formatSearchResult includes score and path', () => {
  const result = formatSearchResult({
    content: '# Header\n\nText content',
    score: 0.85,
    path: 'memory/2026-01-30.md'
  });
  assert(result.includes('[0.85]'));
  assert(result.includes('memory/2026-01-30.md'));
  assert(result.includes('Header Text content'));
});

test('formatter - formatRecentMemory includes path', () => {
  const result = formatRecentMemory({
    content: '## Header\n\nSome text',
    path: 'memory/2026-01-30.md'
  });
  assert(result.includes('memory/2026-01-30.md'));
  assert(result.includes('Header Some text'));
});

test('formatter - formatSearchResults joins with newlines', () => {
  const results = formatSearchResults([
    {
      content: 'Text 1',
      score: 0.9,
      path: 'path/1.md'
    },
    {
      content: 'Text 2',
      score: 0.8,
      path: 'path/2.md'
    }
  ]);
  const lines = results.split('\n');
  assert.equal(lines.length, 2);
});

test('formatter - formatRecentMemories joins with newlines', () => {
  const memories = formatRecentMemories([
    {
      content: 'Text 1',
      path: 'path/1.md'
    },
    {
      content: 'Text 2',
      path: 'path/2.md'
    }
  ]);
  const lines = memories.split('\n');
  assert.equal(lines.length, 2);
});

test('formatter - formatMemoryGet without line info', () => {
  const result = formatMemoryGet('Some text', 'memory/test.md');
  assert(result.includes('memory/test.md'));
  assert(result.includes('Some text'));
});

test('formatter - formatMemoryGet with line info', () => {
  const result = formatMemoryGet('Some text', 'memory/test.md', {
    fromLine: 10,
    toLine: 20,
    totalLines: 100
  });
  assert(result.includes('(lines 10-20/100)'));
});

test('formatter - empty results return empty string', () => {
  assert.equal(formatSearchResults([]), '');
  assert.equal(formatRecentMemories([]), '');
});
