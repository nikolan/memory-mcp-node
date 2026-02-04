When knowledge evolves (e.g., "prefers npm" → "prefers pnpm"), both entries can exist in MEMORY.md and both will match a semantic
  search for "package manager preference."

  Current behavior:
  - Jaccard deduplication (85%) catches near-duplicates but not evolved facts — "prefers npm" and "prefers pnpm" have ~50% Jaccard similarity, so both survive
  - Both get returned to the LLM, potentially causing confusion
  - No timestamp-based recency signal in search results

  Supersedes Mechanism for Evolving Knowledge

 Goal: When knowledge evolves (e.g., "prefers npm" → "prefers pnpm"), detect the conflict and mark the old entry as superseded so search results show clear lineage.

 Constraint: LLM remains optional for core read/write — conflict detection uses LLM only during maintenance promotion phase.

 Status: Previous plan (deduplication improvements) is COMPLETE. This is the next iteration.

 ---
 The Problem

 When facts change over time, both old and new entries exist in MEMORY.md. Search returns both with similar scores, potentially confusing the client LLM.

 Example:
 ### 2026-01-15
 Uses npm for package management

 ### 2026-02-01
 Switched to pnpm - faster installs, better monorepo support

 Both match "package manager preference" with ~0.6 score. No signal about which is authoritative.

 Current mitigations (insufficient):
 - Jaccard 85% dedup catches near-duplicates but NOT evolved facts ("npm" vs "pnpm" ~50% similarity)
 - No timestamp-based recency signal in search results

 ---
 Design: Promotion-Time Conflict Detection

 Why at promotion time (not search time)?
 ┌─────────────┬────────────────────────────────────────────┬───────────────────────────────────────────────────┐
 │   Timing    │                    Pros                    │                       Cons                        │
 ├─────────────┼────────────────────────────────────────────┼───────────────────────────────────────────────────┤
 │ Promotion   │ LLM available, writes metadata once, clean │ Requires re-promotion to detect old conflicts     │
 ├─────────────┼────────────────────────────────────────────┼───────────────────────────────────────────────────┤
 │ Search      │ Always fresh                               │ LLM in read path (violates constraint), expensive │
 ├─────────────┼────────────────────────────────────────────┼───────────────────────────────────────────────────┤
 │ Maintenance │ Batch processing, can scan all             │ Delayed detection                                 │
 └─────────────┴────────────────────────────────────────────┴───────────────────────────────────────────────────┘
 Decision: Promotion-time with maintenance backfill for existing content.

 ---
 Data Model

 Add to chunks table:
 superseded_by TEXT DEFAULT NULL,   -- chunk ID that supersedes this one
 supersedes TEXT DEFAULT NULL,      -- chunk ID this supersedes
 conflict_reason TEXT DEFAULT NULL  -- "updated", "corrected", "contradicts"

 Search results enhanced with conflict metadata:
 interface SearchResult {
   // existing fields...
   supersededBy?: string;      // If this result is outdated
   supersedes?: string;        // If this result updates older content
   conflictReason?: string;    // Why it was superseded
 }

 ---
 Implementation

 Phase 1: Schema Migration

 File: src/core/database.ts

 1. Add columns to initializeDatabase() (~line 67)
 2. Add migration for existing DBs (~line 80)
 3. Add markSupersedes() helper function (~line 625)

 Phase 2: Conflict Detection Function

 File: src/core/promotion.ts

 1. Add detectConflicts() function that uses LLM to compare new chunk against existing MEMORY.md entries in same category
 2. Returns: { conflictsWith: chunkId, reason: 'updates'|'corrects'|'contradicts', confidence: 0-1 }
 3. Only triggers for chunks in same category (User Preferences, Important Decisions, etc.)

 Phase 3: Integrate into Promotion

 File: src/core/promotion.ts

 In promoteToLongTerm() before appendToMemorySection():
 - Call detectConflicts() for each candidate
 - If conflict found with confidence > 0.7, call markSupersedes()
 - Log the supersession relationship

 Phase 4: Surface in Search Results

 File: src/core/search.ts

 1. Update SELECT queries to include superseded_by, supersedes, conflict_reason
 2. Map to SearchResult interface

 File: src/tools/index.ts

 Format output with visual indicators:
 ⚠️ SUPERSEDED by newer entry
 ✓ Updates older entry

 Phase 5: Maintenance Backfill

 File: src/core/maintenance.ts

 Add --action conflicts to scan existing MEMORY.md and detect conflicts retroactively using same LLM logic.

 ---
 Files to Modify
 ┌─────────────────────────┬──────────────────────────────────────────────────────┐
 │          File           │                       Changes                        │
 ├─────────────────────────┼──────────────────────────────────────────────────────┤
 │ src/core/database.ts    │ Add 3 columns, migration, markSupersedes()           │
 ├─────────────────────────┼──────────────────────────────────────────────────────┤
 │ src/core/promotion.ts   │ Add detectConflicts(), integrate into promotion loop │
 ├─────────────────────────┼──────────────────────────────────────────────────────┤
 │ src/core/search.ts      │ Include conflict metadata in results                 │
 ├─────────────────────────┼──────────────────────────────────────────────────────┤
 │ src/tools/index.ts      │ Format conflict warnings in output                   │
 ├─────────────────────────┼──────────────────────────────────────────────────────┤
 │ src/core/maintenance.ts │ Add --action conflicts for backfill                  │
 └─────────────────────────┴──────────────────────────────────────────────────────┘
 ---
 Implementation Order
 ┌─────┬────────────────────────────────────┬────────────────────────────┐
 │  #  │               Change               │            Risk            │
 ├─────┼────────────────────────────────────┼────────────────────────────┤
 │ 1   │ Schema migration (database.ts)     │ Low                        │
 ├─────┼────────────────────────────────────┼────────────────────────────┤
 │ 2   │ markSupersedes() helper            │ Low                        │
 ├─────┼────────────────────────────────────┼────────────────────────────┤
 │ 3   │ detectConflicts() function         │ Medium - LLM prompt tuning │
 ├─────┼────────────────────────────────────┼────────────────────────────┤
 │ 4   │ Integrate into promotion loop      │ Low                        │
 ├─────┼────────────────────────────────────┼────────────────────────────┤
 │ 5   │ Update search result interface     │ Low                        │
 ├─────┼────────────────────────────────────┼────────────────────────────┤
 │ 6   │ Update search queries              │ Low                        │
 ├─────┼────────────────────────────────────┼────────────────────────────┤
 │ 7   │ Format output with warnings        │ Low                        │
 ├─────┼────────────────────────────────────┼────────────────────────────┤
 │ 8   │ Maintenance backfill action        │ Low                        │
 ├─────┼────────────────────────────────────┼────────────────────────────┤
 │ 9   │ Run backfill on existing MEMORY.md │ Low                        │
 └─────┴────────────────────────────────────┴────────────────────────────┘
 ---
 Verification

 1. Schema migration:
 sqlite3 ~/.memory-mcp/index.sqlite ".schema chunks"
 # Should show superseded_by, supersedes, conflict_reason columns
 2. Conflict detection:
 # Store conflicting facts on different days
 # memory_store: "Uses npm for package management"
 # (next day) memory_store: "Switched to pnpm for better monorepo support"

 # Run promotion
 node dist/maintenance.js --action promote --dry-run false
 # Should log: "→ Supersedes MEMORY.md:X-Y (updates)"
 3. Search results:
 # Search for "package manager"
 # Old result should show: "⚠️ SUPERSEDED"
 # New result should show: "✓ Updates older entry"
 4. Backfill:
 node dist/maintenance.js --action conflicts --dry-run
 # Should list detected conflicts without modifying

 node dist/maintenance.js --action conflicts --dry-run false
 # Should mark supersession relationships

 ---
 Cost Estimate

 Conflict detection adds ~1 LLM call per promoted chunk:
 - ~500 input tokens (prompt + existing chunks in same category)
 - ~50 output tokens (JSON response)
 - Cost: ~$0.002 per chunk

 For typical usage (5-10 promotions/day): ~$0.01-0.02/day additional

 ---
 LLM Prompt Design

 Compare this new memory entry against existing entries in the same category.

 NEW ENTRY:
 ${newChunk.text}

 EXISTING ENTRIES:
 ${sameCategory.map((c, i) => `[${i}] ${c.text}`).join('\n\n')}

 Does the new entry UPDATE, CORRECT, or CONTRADICT any existing entry?
 - UPDATE: Same topic, newer information (e.g., "now uses pnpm" updates "uses npm")
 - CORRECT: Fixes a mistake (e.g., "actually prefers tabs" corrects "prefers spaces")
 - CONTRADICT: Incompatible facts that need resolution

 Respond with JSON: { "conflicts": false } or { "conflicts": true, "index": <number>, "reason": "updates|corrects|contradicts", "confidence": 0.0-1.0 }

 ---
 Not Doing

 - Search-time conflict detection (violates LLM-optional constraint for reads)
 - Automatic deletion of superseded entries (keep for audit trail)
 - Complex conflict resolution UI (client LLM handles interpretation)
 - Graph-based relationship tracking (overkill for current scale)
 - Transitive supersession chains (A→B→C) — keep it simple with direct links