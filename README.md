# local-memory-mcp

Persistent, searchable memory for AI assistants. Store conversations, decisions, and preferences in plain Markdown with hybrid search. Designed for agentic workflows.

Combines BM25 keyword search and vector semantic search using **Reciprocal Rank Fusion (RRF)** with top-rank bonuses—all running locally via transformers.js.

## Quick Start

```bash
# Install and build
pnpm install
pnpm run build

# Set environment variable (add to ~/.zshrc or ~/.bashrc)
export LOCAL_MEMORY_MCP="/path/to/memory-mcp-node"
```

**MCP Client Configuration:**

```json
{
  "memory": {
    "command": "bash",
    "args": ["-c", "node \"$LOCAL_MEMORY_MCP/dist/index.js\""]
  }
}
```

### Agent Instructions

Add [`MEMORY_PROTOCOL_RULE.md`](./MEMORY_PROTOCOL_RULE.md) to your coding agent:

| Agent | Location |
|-------|----------|
| Cursor | User rules or project `.cursorrules` |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     local-memory-mcp Hybrid Search Pipeline                 │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌─────────────────┐
                              │   User Query    │
                              └────────┬────────┘
                                       │
                        ┌──────────────┴──────────────┐
                        ▼                             ▼
               ┌────────────────┐            ┌────────────────┐
               │  Vector Search │            │  BM25 Search   │
               │  (semantic)    │            │  (keywords)    │
               └───────┬────────┘            └───────┬────────┘
                       │                             │
                       │ Ranked List                 │ Ranked List
                       │                             │
                       └──────────────┬──────────────┘
                                      │
                          ┌───────────────────────┐
                          │   RRF Fusion (k=60)   │
                          │  score = Σ 1/(k+rank) │
                          └───────────┬───────────┘
                                      │
                          ┌───────────────────────┐
                          │   Top-Rank Bonus      │
                          │  #1 in either: +0.05  │
                          │  #1 in both:   +0.10  │
                          └───────────┬───────────┘
                                      │
                          ┌───────────────────────┐
                          │   Deduplication       │
                          │  70% Jaccard threshold│
                          └───────────────────────┘
```

### Score Fusion Strategy

| Backend | Raw Score | RRF Contribution |
|---------|-----------|------------------|
| **Vector** | Cosine similarity | `1 / (60 + rank)` |
| **BM25** | SQLite FTS5 | `1 / (60 + rank)` |

**Why RRF?** Weighted blending (`0.7×vector + 0.3×bm25`) creates muddy middle ground where correct results are barely distinguishable from noise. RRF with top-rank bonus creates decisive confidence gaps:

| Query | Old Gap | New Gap |
|-------|---------|---------|
| Exact match | 2.0× | **8.2×** |
| Fuzzy match | 1.0× | **4.1×** |

### Storage Structure

```
~/.memory-mcp/
├── MEMORY.md          # Long-term memories (source of truth)
├── index.sqlite       # Search index (vector + FTS5 + metadata)
└── memory/
    ├── 2025-01-28.md  # Daily conversation files
    └── 2025-01-29.md
```

### Data Flow

**Write (`memory_store`):**
```
Text ──► Chunk (400 tokens) ──► Embed (384d) ──► Store in:
                                                 ├─ Markdown file
                                                 ├─ Vector index (sqlite-vec)
                                                 └─ Keyword index (FTS5)
```

**Read (`memory_search`):**
```
Query ──► Embed ──► [Vector Search] ─┬─► RRF Fusion ──► Top-Rank Bonus ──► Results
                   [BM25 Search]   ──┘
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `memory_search` | Hybrid search (vector + BM25 + RRF) |
| `memory_store` | Save new information |
| `memory_list_recent` | Load recent context (past N days) |
| `memory_get` | Read specific file by path |
| `memory_forget` | Delete memories (with preview) |
| `memory_status` | Check system health |

## Tech Stack

| Technology | Purpose |
|------------|---------|
| [transformers.js](https://huggingface.co/docs/transformers.js) | Local embeddings (384d, offline) |
| SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec) | Vector + keyword index |
| Markdown files | Human-readable storage |
| Anthropic Claude | Maintenance only (optional) |

## Maintenance (Optional)

Separate CLI tool for automatic cleanup and fact extraction. Requires `ANTHROPIC_API_KEY`.

```bash
# Check status
node dist/maintenance.js --action check

# Run full maintenance
node dist/maintenance.js --action full --dry-run false
```

| Action | What it does |
|--------|--------------|
| `retention` | Delete old daily files |
| `compaction` | Deduplicate within daily files |
| `promotion` | Extract important facts to MEMORY.md |
| `cleanup` | Remove noise, re-index |
| `full` | Run all in optimal order |

**Cost:** ~$0.05-0.25 per full run, ~$1.50-7.50/month with daily cron.

### Schedule

```bash
node dist/maintenance.js schedule
```

Interactive menu to create/view/remove daily cron job (09:00 UTC).

## Configuration

**API Keys** (`~/.memory-mcp/.env`):
```bash
# Optional - only needed for maintenance
ANTHROPIC_API_KEY=sk-ant-...
```

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

## Development

```bash
pnpm install
pnpm run build
pnpm run dev    # watch mode
pnpm run test   # 51 tests
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `src/core/search.ts` | RRF hybrid search |
| `src/core/database.ts` | SQLite + sqlite-vec |
| `src/core/indexer.ts` | Chunking + embeddings |
| `src/core/maintenance.ts` | Cleanup orchestration |

## Requirements

- Node.js 18+
- pnpm (or npm)
- Anthropic API key (optional, for maintenance)

## License

MIT
