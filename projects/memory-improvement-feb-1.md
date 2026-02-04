# Memory Search Quality Improvements - Revised Plan

**Date:** 2026-02-01
**Status:** Ready for implementation
**Goal:** Reduce retrieval volume, eliminate duplicates, cleaner MEMORY.md
**Constraint:** No LLM dependency for core read/write — client Haiku subagents handle condensation

---

## Architecture Decision

**LLM stays optional** (maintenance only). The MCP server returns deduplicated, well-formatted results. The client's Haiku subagent protocol handles interpretation/condensation. This keeps the server simple and leverages your existing MEMORY_PROTOCOL_RULE.md pattern.

---

## Phase 1: Fix MEMORY.md Format & Deduplication (Critical)

### Problems
1. `src/core/promotion.ts:117` wraps content in `<details>` tags — LLMs don't interact with collapsible UI, this just adds noise and causes nesting issues
2. Deduplication only checks against current run's `promotedTexts`, not existing MEMORY.md content

### Changes

**File: `src/core/promotion.ts`**

1. **Remove `<details>` wrapping entirely** (line 117)
   - Change `appendToMemorySection()` to use plain markdown format:
   ```typescript
   // BEFORE (line 117):
   const entryContent = `\n### ${dateStr}\n\n${summary}\n\n<details>\n<summary>Original context</summary>\n\n${originalText}\n\n</details>\n`;

   // AFTER:
   const entryContent = `\n### ${dateStr}\n\n${summary}\n\n**Context:**\n${originalText}\n`;
   ```

2. **Add `extractExistingPromotedContent()` function** (~line 140)
   - Parse MEMORY.md and extract text from each `### date` section
   - Return array of existing promoted texts for dedup comparison
   ```typescript
   function extractExistingPromotedContent(memoryFilePath: string): string[] {
     if (!fs.existsSync(memoryFilePath)) return [];
     const content = fs.readFileSync(memoryFilePath, 'utf-8');
     // Split by ### headers, extract text content from each section
     const sections = content.split(/^### /m).filter(Boolean);
     return sections.map(s => s.replace(/^[^\n]+\n/, '').trim()); // Remove date header
   }
   ```

3. **Modify `promoteToLongTerm()` (line 263)**
   - Before promotion loop, load existing MEMORY.md content
   - Check candidates against both `promotedTexts` AND existing content
   ```typescript
   const existingTexts = extractExistingPromotedContent(memoryFilePath);
   // In loop (line 287):
   if (isDuplicateOfPromoted(chunk.text, [...promotedTexts, ...existingTexts], 0.85)) {
     result.skipped++;
     if (!dryRun) markChunksAsPromoted(db, [chunk.id]);
     continue;
   }
   ```

---

## Phase 2: Extract Shared Text Utils

### Problem
Jaccard similarity logic exists in `promotion.ts` (`calculateTextSimilarity`, line 229). Search deduplication needs the same logic. Avoid duplication.

### Changes

**New file: `src/core/textUtils.ts`**

```typescript
/**
 * Extract words (>2 chars) from text for similarity comparison
 */
export function extractWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2)
  );
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|
 */
export function jaccardSimilarity(text1: string, text2: string): number {
  const words1 = extractWords(text1);
  const words2 = extractWords(text2);

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}
```

**Update `src/core/promotion.ts`:**
- Import from textUtils instead of inline `calculateTextSimilarity`
- Remove lines 229-242, replace with import

---

## Phase 3: Search Result Deduplication (High Impact)

### Problem
Overlapping chunks (80 token overlap) return near-duplicate content in search results. Current merge only dedupes by chunk ID.

### Changes

**File: `src/core/search.ts`**

1. **Import shared util**
   ```typescript
   import { jaccardSimilarity } from './textUtils';
   ```

2. **Add `deduplicateResults()` function** (~line 230)
   ```typescript
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
   ```

3. **Integrate into `hybridSearch()` (line 224)**
   - After sorting by score, before returning
   ```typescript
   const sorted = merged.sort((a, b) => b.score - a.score);
   const deduplicated = deduplicateResults(sorted, 0.7);
   return deduplicated.filter(r => r.score >= minScore).slice(0, maxResults);
   ```

---

## Phase 4: Reduce Chunk Overlap (Simple)

### Problem
80 token overlap creates redundant chunks that inflate search results.

### Change

**File: `src/core/indexer.ts` (line 34)**

```typescript
const overlap = options?.overlap ?? 40; // was 80
```

**Note:** After changing overlap, existing chunks remain in DB with old overlap. Run `npm run maintenance -- full` to re-chunk all files with new setting.

**Tradeoff:** Less context per chunk, but Phase 3 deduplication + your Haiku subagent protocol compensate by fetching related context when needed.

---

## Phase 5: One-Time MEMORY.md Cleanup

### Problem
Existing MEMORY.md has `<details>` tags (now deprecated) and duplicate content.

### Changes

**File: `src/core/promotion.ts`**

1. **Add `cleanupMemoryFile()` function**
   ```typescript
   import { jaccardSimilarity } from './textUtils';

   interface CleanupResult {
     sectionsRemoved: number;
     bytesReduced: number;
     detailsStripped: number;
   }

   export async function cleanupMemoryFile(memoryFilePath: string): Promise<CleanupResult> {
     const content = fs.readFileSync(memoryFilePath, 'utf-8');
     const originalSize = content.length;
     let detailsStripped = 0;

     // 1. Strip all <details>...</details> wrappers, keep inner content
     let cleaned = content.replace(
       /<details>\s*<summary>[^<]*<\/summary>\s*([\s\S]*?)\s*<\/details>/g,
       (match, inner) => { detailsStripped++; return `**Context:**\n${inner.trim()}`; }
     );

     // 2. Parse into sections by ### headers
     const sections = cleaned.split(/(?=^### )/m).filter(Boolean);

     // 3. Deduplicate sections with >85% Jaccard similarity (keep longest)
     const unique: string[] = [];
     for (const section of sections) {
       const isDupe = unique.some(u => jaccardSimilarity(u, section) > 0.85);
       if (!isDupe) {
         unique.push(section);
       } else {
         // Keep longer version
         const dupeIndex = unique.findIndex(u => jaccardSimilarity(u, section) > 0.85);
         if (section.length > unique[dupeIndex].length) {
           unique[dupeIndex] = section;
         }
       }
     }

     // 4. Rewrite file
     const result = unique.join('\n');
     fs.writeFileSync(memoryFilePath, result);

     return {
       sectionsRemoved: sections.length - unique.length,
       bytesReduced: originalSize - result.length,
       detailsStripped,
     };
   }
   ```

2. **Add CLI command**

   **File: `src/maintenance.ts`**
   - Add 'cleanup' to MaintenanceAction type
   - Add handler:
   ```typescript
   if (action === 'cleanup') {
     const result = await cleanupMemoryFile(memoryFilePath);
     console.log(`Cleaned: removed ${result.sectionsRemoved} duplicate sections, ` +
                 `stripped ${result.detailsStripped} <details> tags, ` +
                 `reduced ${result.bytesReduced} bytes`);
     // Re-index
     await reindexMemoryFile(db, memoryFilePath, embeddingConfig);
   }
   ```

---

## Phase 6: Query-Adaptive Weights (Optional Enhancement)

### Problem
Static 70/30 vector/BM25 regardless of query type.

### Changes

**File: `src/core/search.ts`**

1. **Add `getQueryWeights()` function** (~line 165)
   ```typescript
   function getQueryWeights(query: string): { vector: number; bm25: number } {
     const isQuoted = /^["'].*["']$/.test(query.trim());
     const isTicketId = /[A-Z]{2,}-\d+/.test(query);
     const isShortExact = query.split(/\s+/).length <= 2 && !query.includes('?');

     if (isQuoted || isTicketId || isShortExact) {
       return { vector: 0.5, bm25: 0.5 }; // Boost keyword matching
     }
     return { vector: 0.7, bm25: 0.3 }; // Default semantic-heavy
   }
   ```

2. **Use in `hybridSearch()`**
   - Replace hardcoded weights with dynamic weights based on query

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/core/textUtils.ts` | **NEW** — shared Jaccard similarity |
| `src/core/promotion.ts` | remove `<details>`, cross-run dedup, cleanup function, use textUtils |
| `src/core/search.ts` | result deduplication, query-adaptive weights, use textUtils |
| `src/core/indexer.ts` | reduce overlap 80→40 |
| `src/maintenance.ts` | add 'cleanup' action |

---

## Implementation Order

| # | Phase | Change | Risk |
|---|-------|--------|------|
| 1 | 2 | Create `src/core/textUtils.ts` with Jaccard similarity | Low |
| 2 | 1 | Remove `<details>` from `appendToMemorySection()` | Low |
| 3 | 1 | Add `extractExistingPromotedContent()` | Low |
| 4 | 1 | Update `promoteToLongTerm()` cross-run dedup | Low |
| 5 | 5 | Add `cleanupMemoryFile()` + CLI command | Low |
| 6 | — | **Run cleanup on existing MEMORY.md** | Low |
| 7 | 3 | Add `deduplicateResults()` in search.ts | Low |
| 8 | 4 | Change overlap 80→40 in indexer.ts | Low |
| 9 | — | **Run `npm run maintenance -- full` to re-index** | Low |
| 10 | 6 | Query-adaptive weights (optional) | Low |

---

## Verification

1. **MEMORY.md cleanup**
   ```bash
   # Before: count details tags and file size
   grep -c '<details>' ~/.memory/MEMORY.md
   wc -c ~/.memory/MEMORY.md

   # Run cleanup
   npm run maintenance -- cleanup

   # After: should be 0 details tags, smaller file
   grep -c '<details>' ~/.memory/MEMORY.md
   wc -c ~/.memory/MEMORY.md
   ```

2. **Search deduplication**
   ```bash
   # Use MCP inspector or test script to search for something
   # that previously returned near-duplicate chunks
   # Verify results have no overlapping content
   ```

3. **Promotion dedup**
   ```bash
   # Store same content twice
   # Run promotion
   npm run maintenance -- promote --dry-run
   # Verify logs show "skipped" for duplicate content
   ```

4. **End-to-end test**
   ```bash
   # After all changes:
   npm run maintenance -- full

   # Verify search returns deduplicated, concise results
   # Verify MEMORY.md has no <details> tags and no duplicates
   ```

---

## MEMORY_PROTOCOL_RULE.md

**No changes needed.** The protocol describes behavior (when to search, what to store, Haiku subagent delegation). This plan changes infrastructure (storage format, deduplication). Subagents continue calling `memory_search` and `memory_store` exactly as before—they just get cleaner results.

---

## Not Doing

- Neo4j (deferred — SQLite sufficient for current needs)
- LLM in read path (client Haiku subagents handle this)
- Entity extraction (can add later if needed)
- Link extraction table (extract on-demand from text)
- Write-triggered compaction (daily maintenance sufficient)
- Post-compaction freshness boost (unnecessary complexity)
