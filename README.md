# local-memory-mcp

Persistent, searchable memory for AI assistants. Store conversations, decisions, and preferences in plain Markdown with hybrid vector + keyword search.

## Features

- **Local Embeddings** - transformers.js runs entirely offline (no API needed)
- **Hybrid Search** - Vector embeddings + BM25 keyword matching
- **Plain Markdown** - Human-readable files you can edit directly
- **Zero Config** - Works out of the box, API keys optional

## Quick Start

### Install and build

```bash
pnpm install
pnpm run build
```

### Set up environment variable

Add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export LOCAL_MEMORY_MCP="/path/to/memory-mcp-node"
```

### Add to your MCP client config:

```json
{
  "memory": {
    "command": "bash",
    "args": ["-c", "node \"$LOCAL_MEMORY_MCP/dist/index.js\""]
  }
}
```

### Instruct your tools

Add [`MEMORY_PROTOCOL_RULE.md`](./MEMORY_PROTOCOL_RULE.md) to your coding agent:

| Agent | Location |
|-------|----------|
| Cursor | User rules or project `.cursorrules` |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |

## Storage Structure

```
~/.memory-mcp/
├── MEMORY.md          # Long-term memories
├── index.sqlite       # Search index
└── memory/
    ├── 2025-01-28.md  # Daily files
    └── 2025-01-29.md
```

Optional: set up [maintenance](#maintenance) later for automatic cleanup and long-term memory extraction.

## Architecture

**Markdown files + SQLite database**

### Storage Structure

**Markdown files (source of truth):**
- `MEMORY.md` — long-term memories
- `memory/YYYY-MM-DD.md` — daily conversation files
- Human-readable and editable

**SQLite database (`index.sqlite`) — search index + text cache:**
- Stores text content (in `chunks` table)
- Vector embeddings (in `chunks_vec` table) — 384-dimensional vectors
- Keyword index (in `chunks_fts` table) — BM25 full-text search
- Metadata (`superseded_by`, `supersedes`, `conflict_reason`, etc.)

### How It Works

**When you call `memory_store`:**
1. Writes to markdown file first (daily file or MEMORY.md)
2. Reads the file back
3. Chunks the content (400 tokens per chunk, 40 token overlap)
4. Generates embeddings (384d vectors)
5. Stores in SQLite:
   - Text content in `chunks` table
   - Embeddings in `chunks_vec` table
   - Keywords in `chunks_fts` table

**When you call `memory_search`:**
1. Generates embedding for your query
2. Runs dual search in parallel:
   - **Vector similarity search** (`chunks_vec`) — finds semantically similar content
   - **Keyword search** (`chunks_fts`) — finds exact term matches using BM25
3. **Blends scores** using weighted combination:
   - Vector score × 70% (semantic meaning)
   - BM25 score × 30% (exact terms)
   - Formula: `(0.7 × vectorScore) + (0.3 × bm25Score)`
4. Merges results by chunk ID (if same chunk appears in both searches)
5. Deduplicates near-identical results (70%+ similarity threshold)
6. Filters by minimum score (default: 0.35) and returns top results

### Important Points

- **Markdown files are the source of truth** — you can edit them directly
- **Database stores text + indexes** — not just indexes; it duplicates text for fast search
- **Database can be rebuilt** — if you delete `index.sqlite`, it can be recreated from the markdown files (via re-indexing)

### Why This Design?

- **Human-readable storage** (markdown files)
- **Fast search** (SQLite with vector + keyword indexes)
- **Redundancy** (database can be rebuilt from files)
- **Editability** (you can edit MEMORY.md directly, then re-index)

**Summary:** Markdown files = source of truth, SQLite = searchable cache with embeddings + text + metadata.

Two separate tools:

| Tool | Purpose | API Key |
|------|---------|---------|
| `local-memory-mcp` | MCP server (search, store, get) | Not required |
| `local-memory-mcp-maintenance` | CLI for maintenance & scheduling | Required |

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Clients                          │
│              (Cursor, Codex, Claude Code)               │
└─────────────────────┬───────────────────────────────────┘
                      │ MCP Protocol
┌─────────────────────▼───────────────────────────────────┐
│                  Memory Server                          │
├─────────────────────────────────────────────────────────┤
│  Embeddings: transformers.js (local, 384 dims)          │
│  LLM: Anthropic (optional, for maintenance only)        │
├─────────────────────────────────────────────────────────┤
│  Storage: SQLite + sqlite-vec │ Markdown files          │
└─────────────────────────────────────────────────────────┘
```

### Tech Stack

| Technology | Layer | Used in |
|------------|-------|---------|
| [transformers.js](https://huggingface.co/docs/transformers.js) | Embeddings | Store, Search |
| SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec) | Index | Store, Search |
| Markdown files | Storage | Store, Read |
| Anthropic Claude | LLM | Maintenance |

### How it works

## Search & Storage Data Flow

```
USER QUERY: "database preferences"
                    ↓
        ┌───────────────────────────────┐
        │ 1. EMBEDDING GENERATION       │
        │ Input: User query string      │
        │ Process: Convert to vector    │
        │ (384-dimensional)             │
        │ Output: Query embedding       │
        └───────────────────────────────┘
                    ↓
        ┌───────────────────────────────────────────┐
        │ 2. DUAL SEARCH (Parallel)                 │
        ├───────────────────────────────────────────┤
        │ PATH A: SEMANTIC SEARCH                   │
        │ ├─ Find vectors closest to query          │
        │ │  in vector space                        │
        │ ├─ Scores: 0.0-1.0 (higher = closer)    │
        │ └─ Example: "Postgres for ACID" ≈ 0.85  │
        │                                           │
        │ PATH B: KEYWORD SEARCH (BM25)             │
        │ ├─ Find entries matching words            │
        │ ├─ Scores: ranked by term importance     │
        │ └─ Example: "database" exact match ≈ 0.9 │
        └───────────────────────────────────────────┘
                    ↓
        ┌───────────────────────────────────────────┐
        │ 3. HYBRID SCORE BLENDING                  │
        │ ├─ Semantic: 70% weight (meaning)        │
        │ ├─ Keyword: 30% weight (exact terms)     │
        │ └─ Formula: (0.7 × semantic) +            │
        │            (0.3 × keyword)                │
        │ Result: Blended score 0.0-1.0             │
        └───────────────────────────────────────────┘
                    ↓
        ┌───────────────────────────────────────────┐
        │ 4. RESULT DEDUPLICATION                   │
        │ ├─ Compare top results pairwise           │
        │ ├─ Remove 70%+ similar chunks             │
        │ ├─ Keep highest-scoring variant           │
        │ └─ Result: Reduced noise, better signal   │
        └───────────────────────────────────────────┘
                    ↓
        ┌───────────────────────────────────────────┐
        │ 5. FILTERING & RANKING                    │
        │ ├─ Keep scores ≥ 0.35 (relevance)        │
        │ ├─ Sort by score (highest first)          │
        │ └─ Return top 6 results (configurable)     │
        └───────────────────────────────────────────┘
                    ↓
        SEARCH RESULTS:
        [0.85] memory/MEMORY.md: "Chose Postgres for ACID compliance"
        [0.78] memory/2025-01-28.md: "Database choice: ACID transactions"
        [0.71] memory/2025-01-27.md: "SQL preferences discussed"
```

## Storage (Write) Data Flow

```
USER STORES: "We chose Postgres because of ACID"
                    ↓
        ┌───────────────────────────────┐
        │ 1. PARSE & CHUNK              │
        │ ├─ Input: Plain text          │
        │ ├─ Chunk size: 400 tokens     │
        │ ├─ Overlap: 40 tokens         │
        │ │  (context continuity)       │
        │ └─ Output: 1-3 chunks         │
        └───────────────────────────────┘
                    ↓
        ┌───────────────────────────────┐
        │ 2. EMBEDDING GENERATION       │
        │ ├─ Input: Text chunks         │
        │ ├─ Process: In parallel       │
        │ │  (batch size: 8)            │
        │ └─ Output: Embeddings (384d)  │
        └───────────────────────────────┘
                    ↓
        ┌───────────────────────────────────────────┐
        │ 3. STORAGE: THREE PLACES                  │
        ├───────────────────────────────────────────┤
        │ A. MARKDOWN FILE                          │
        │    └─ memory/2025-01-29.md                │
        │       (human-editable, readable)          │
        │                                           │
        │ B. VECTOR INDEX                           │
        │    └─ SQLite + vec0 extension             │
        │       (fast semantic search)              │
        │                                           │
        │ C. KEYWORD INDEX                          │
        │    └─ SQLite FTS5 (full-text search)      │
        │       (fast exact term matching)          │
        └───────────────────────────────────────────┘
                    ↓
        DATA IS NOW SEARCHABLE:
        ├─ Immediately via memory_search
        ├─ By vector similarity ("database choices")
        └─ By exact keywords ("Postgres")
```

## Memory Maintenance (Optional Background Process)

```
SCHEDULED MAINTENANCE (daily, if configured)
                    ↓
        ┌─────────────────────────────────────────┐
        │ STEP 1: RETENTION                       │
        │ ├─ Delete files older than 90 days      │
        │ ├─ Update search index                  │
        │ └─ Status: Automatic, no API needed     │
        └─────────────────────────────────────────┘
                    ↓
        ┌─────────────────────────────────────────┐
        │ STEP 2: COMPACTION (per daily file)     │
        │ ├─ Input: memory/2025-01-15.md          │
        │ │         (50+ KB of scattered notes)   │
        │ ├─ Process:                             │
        │ │  1. Group similar entries (TF-IDF)    │
        │ │  2. Remove near-duplicates            │
        │ │  3. Optionally summarize (LLM)        │
        │ ├─ Output: Cleaned daily file           │
        │ └─ Cost: ~$0.01/file (if LLM enabled)   │
        └─────────────────────────────────────────┘
                    ↓
        ┌─────────────────────────────────────────┐
        │ STEP 3: PROMOTION (extract facts)       │
        │ ├─ Input: All files                     │
        │ │         (daily + long-term)           │
        │ ├─ Identify unpromoted chunks           │
        │ ├─ Score relevance (LLM):               │
        │ │  - 0.9+: Core preferences             │
        │ │  - 0.7-0.9: Important facts           │
        │ │  - <0.5: Transient notes              │
        │ ├─ Check cross-run duplicates           │
        │ │  (vs. existing MEMORY.md)             │
        │ ├─ Append to MEMORY.md if >0.8          │
        │ └─ Cost: ~$0.005/chunk (if LLM enabled) │
        └─────────────────────────────────────────┘
                    ↓
        ┌─────────────────────────────────────────┐
        │ OPTIONAL: CLEANUP                       │
        │ ├─ Remove nested <details> tags         │
        │ ├─ Deduplicate MEMORY.md sections       │
        │ ├─ Re-index database (sync)             │
        │ └─ Cost: Free (local only)              │
        └─────────────────────────────────────────┘
                    ↓
        RESULT:
        ├─ MEMORY.md: 100KB → 65KB (cleaner)
        ├─ Daily files: Consolidated
        ├─ Database: Up-to-date
        └─ Search quality: Improved

═══════════════════════════════════════════════════

WITHOUT MAINTENANCE (User never runs it):
├─ Search still works fully
├─ Vector index updates on write
├─ MEMORY.md never auto-populates
├─ Daily files grow indefinitely
└─ Over time: Search slower (more chunks)

With maintenance cron job (daily):
├─ Search: Same quality + faster
├─ MEMORY.md: Auto-curated facts
├─ Daily files: Archived/deleted
└─ Cost: ~$1-5/month
```

---

| Operation | Data Types | Where | Searchable |
|-----------|------------|-------|-----------|
| **Search** | Query string → Vector (384d) + Keywords | In-memory + SQLite indices | Immediately |
| **Store** | Text → Chunks (400 tokens) → Vectors (384d) | Markdown files + Vector + Keyword indices | Immediately |
| **Compact** | Daily file text → Deduplicated text | Same daily file | After re-index |
| **Promote** | Chunk text + LLM score → MEMORY.md entry | MEMORY.md + indices | After re-index |
| **Cleanup** | MEMORY.md text → Deduplicated text | MEMORY.md + indices | After re-index |

## Configuration

**API Keys** (local `.env` or environment variable):
```bash
# Optional - only needed for maintenance
ANTHROPIC_API_KEY=sk-ant-...
```

The maintenance CLI checks `process.env.ANTHROPIC_API_KEY` first, then local `.env` in the current directory.

**Settings** (`config.json`):
```json
{
  "memoryDir": "/Users/you/.memory-mcp",
  "maintenance": {
    "compactionThresholdKB": 50,
    "promotionScoreThreshold": 0.8
  }
}
```

## MCP Client Setup

### Option 1: Published package (after npm publish)

```json
{
  "memory": {
    "command": "npx",
    "args": ["-y", "local-memory-mcp"]
  }
}
```

### Option 2: Local development

Add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export LOCAL_MEMORY_MCP="/path/to/memory-mcp-node"
```

Then use this MCP config:

```json
{
  "memory": {
    "command": "bash",
    "args": ["-c", "node \"$LOCAL_MEMORY_MCP/dist/index.js\""]
  }
}
```

### Cursor

Settings → Features → MCP Servers → paste the config above.

### Claude Code

Add to `~/.claude/CLAUDE.md` - see [Memory Protocol](#memory-protocol).

### Codex

Add to `~/.codex/AGENTS.md` - see [Memory Protocol](#memory-protocol).

## MCP Tools

| Tool | Purpose |
|------|---------|
| `memory_search` | Find memories (hybrid vector + keyword) |
| `memory_store` | Save new information |
| `memory_list_recent` | Load recent context |
| `memory_get` | Read specific file by path |
| `memory_forget` | Remove memories |
| `memory_status` | Check system health |

## Deduplication

Memory-mcp automatically removes duplicates at multiple levels:

### Search Results (70% threshold)
Hybrid search removes near-duplicate chunks using Jaccard word-set similarity. Reduces noise while preserving unique context.

### Promotion (85% threshold)
When promoting facts to `MEMORY.md`, the system checks against:
- Previously promoted entries **from the current run**
- Existing entries **already in MEMORY.md** (cross-run dedup)

Prevents duplicate facts from being promoted multiple times.

### Cleanup Action
`npm run maintenance -- --action cleanup` provides deep deduplication:
1. Strips nested `<details>` HTML tags from MEMORY.md (causes bloat)
2. Deduplicates MEMORY.md sections using 85% Jaccard similarity
3. Re-indexes database chunks to stay in sync with cleaned file

**Example**: After cleanup on a user's memory store:
- `<details>` tags: 18 → 0 (-100%)
- Duplicate sections: 153 → 109 (-29%)
- Search results: 8 → 6 (-25% bloat)

## Maintenance

Separate CLI tool. Requires `ANTHROPIC_API_KEY`.

```bash
# Published package
npx local-memory-mcp-maintenance [run|schedule]

# Local development
node "$LOCAL_MEMORY_MCP/dist/maintenance.js" [run|schedule]
```

### Run Maintenance

```bash
# Check status (dry run by default)
node dist/maintenance.js --action check

# Run full maintenance (runs all tasks in optimal order)
# Retention → Compaction → Promotion → Conflict Detection → Cleanup
node dist/maintenance.js --action full --dry-run false
```

**Full maintenance runs all tasks automatically:**
1. **Retention** - Delete old daily files beyond retention period
2. **Compaction** - Deduplicate daily files
3. **Promotion** - Move important content to MEMORY.md (with conflict detection)
4. **Conflict Detection** - Detect and mark supersession relationships
5. **Cleanup** - Clean MEMORY.md and re-index

| Action | What it does |
|--------|--------------|
| `check` | Show maintenance status only (no changes) |
| `full` | Run all maintenance tasks in optimal order |
|--------|--------------|
| `check` | Show maintenance status only (no changes) |
| `full` | Run all maintenance tasks: retention → compact → promote → conflicts → cleanup |

### Schedule Maintenance

```bash
npx local-memory-mcp-maintenance schedule
```

Interactive menu to:
- View current schedule
- Create new schedule (daily at 09:00 UTC) - replaces any existing
- Remove schedule

**Requirements for cron:**
- `ANTHROPIC_API_KEY` must be in the cron environment
- `LOCAL_MEMORY_MCP` must point to the repo root
- Set both in your shell profile (`~/.zshrc`, `~/.bashrc`)

### API Usage Costs

Maintenance uses Claude for compaction and promotion:

| Operation | Tokens (approx) | Cost (Claude Sonnet) |
|-----------|-----------------|----------------------|
| Compact (per file) | ~2K input, ~500 output | ~$0.01 |
| Promote (per chunk) | ~1K input, ~200 output | ~$0.005 |
| Full maintenance | ~10-50K tokens | ~$0.05-0.25 |

Daily cron = ~$1.50-7.50/month depending on memory volume.

## Development

```bash
pnpm install
pnpm run build
pnpm run dev    # watch mode
pnpm run test   # Run all tests including deduplication tests
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `src/core/search.ts` | Hybrid search with result deduplication |
| `src/core/textUtils.ts` | Shared Jaccard similarity functions |
| `src/core/promotion.ts` | Fact extraction to MEMORY.md with cross-run dedup |
| `src/core/compaction.ts` | Daily file cleanup and consolidation |
| `src/core/maintenance.ts` | Orchestrates all maintenance tasks in optimal order |
| `test/deduplication.test.mjs` | 28 integration tests for dedup features |

### Testing

The project includes 28 integration tests for deduplication:

```bash
# Run all tests
pnpm run test

# Run specific test file
node --test test/deduplication.test.mjs
```

Tests cover:
- Jaccard similarity calculations and thresholds
- Duplicate detection across text lists
- Cleanup functionality (details tag stripping, section dedup)
- Integration scenarios with realistic memory entries

## Requirements

- Node.js 18+
- pnpm (or npm)
- Anthropic API key optional (enables maintenance operations like promote and compact)
