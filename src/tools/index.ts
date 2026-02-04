import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getConfig, ensureMemoryDir, getDatabasePath, getMemoryFilePath, getEmbeddingApiKey } from '../core/config.js';
import type { EmbeddingConfig } from '../core/indexer.js';
import {
  createDatabase,
  initSchema,
  EMBEDDING_DIMENSIONS,
  insertChunk,
  deleteChunksByPath,
  getChunksByPath,
  getAllPaths,
  getRecentMemories,
  getMemoryStats,
  deleteMemoryByPath,
} from '../core/database.js';
import { generateEmbeddings, chunkText, hashContent } from '../core/indexer.js';
import { hybridSearch } from '../core/search.js';
import { formatSearchResults, formatRecentMemories, formatMemoryGet } from '../core/formatter.js';
import * as fs from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import * as path from 'path';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Creates embedding config from the main config
 */
function getEmbeddingConfig(config: ReturnType<typeof getConfig>): EmbeddingConfig {
  return {
    provider: config.embeddingProvider,
    apiKey: getEmbeddingApiKey(config),
    model: config.embeddingModel,
  };
}

/**
 * Gets embedding dimension based on provider
 */
function getEmbeddingDimension(provider: string): number {
  return EMBEDDING_DIMENSIONS[provider] || 384;
}

const inferTimeRangeMention = (query: string): boolean => {
  const q = query.toLowerCase();
  if (/(today|yesterday|tomorrow|tonight|this\s+(week|month|year|quarter)|last\s+(week|month|year|quarter)|past\s+\d+\s+(day|days|week|weeks|month|months|year|years)|in\s+the\s+last\s+\d+\s+(day|days|week|weeks|month|months|year|years)|since\s+\w+|from\s+\w+\s+to\s+\w+|\b\d{4}-\d{2}-\d{2}\b)/.test(q)) {
    return true;
  }
  return /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/.test(q);
};

/**
 * MCP Tool Definitions for Memory System
 * These tools provide semantic memory capabilities for AI assistants
 */
export const toolDefinitions: Tool[] = [
  {
    name: 'memory_search',
    description: `Search through stored memories using semantic similarity and keyword matching.

WHEN TO USE:
- When you need to recall information from previous conversations
- To find relevant context before answering questions
- To check if similar information has been stored before
- To discover patterns or connections across memories
- At the start of a conversation to load relevant context
- When the user asks about specific time periods (e.g. "what did I work on last week?", "summarize yesterday") -> use a larger max_results

WHAT IT RETURNS:
- List of matching memory entries with their content
- Relevance scores (0-1, higher is better)
- File paths for accessing full content

SEARCH STRATEGY:
- Uses hybrid search combining semantic embeddings and keyword BM25
- Semantic search finds conceptually related content
- Keyword search finds exact term matches
- Results are ranked by combined relevance score

PARAMETERS:
- query: What to search for (concepts, keywords, or questions)
- max_results: Maximum number of results to return (default: matches maxDailyChats from config)
- min_score: Minimum relevance threshold 0-1 (default: 0.35, lower=more results)`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - can be keywords, concepts, or natural language questions'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return'
        },
        min_score: {
          type: 'number',
          description: 'Minimum relevance score (0-1). Lower values return more results.',
          default: 0.35
        }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_get',
    description: `Read specific lines from a memory file by path.

WHEN TO USE:
- After memory_search returns a path you want to read in full
- To view complete context around a memory chunk
- To read long memories that were truncated in search results
- To see the full content before deciding to modify or delete

WHAT IT RETURNS:
- Specified lines from the memory file
- Full text content without truncation
- Line numbers for navigation

PARAMETERS:
- path: Relative path from memory directory (e.g., "memory/2024-01-27.md")
- from_line: Starting line number (default: 1)
- lines: Number of lines to read (default: 15, use 999999 for entire file)`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to memory file from memory directory'
        },
        from_line: {
          type: 'number',
          description: 'Line number to start reading from (1-indexed)',
          default: 1
        },
        lines: {
          type: 'number',
          description: 'Number of lines to read',
          default: 15
        }
      },
      required: ['path']
    }
  },
  {
    name: 'memory_store',
    description: `Store new information into the memory system.

WHEN TO USE:
- When user explicitly shares information to remember
- After important decisions or conclusions in conversations
- To capture user preferences, settings, or configurations
- To save contact information or important details
- To record facts, learnings, or insights for future reference
- When you discover something worth remembering about the user

WHAT IT RETURNS:
- Confirmation of storage
- File path where memory was saved
- Whether content was deduplicated (already existed)

STORAGE BEHAVIOR:
- Automatically deduplicates identical content
- Stores in daily memory files by default
- Indexes for semantic and keyword search
- Chunks long content for efficient retrieval

PARAMETERS:
- content: The information to store (markdown formatted)
- to_long_term: Whether to store in MEMORY.md (default: false, stores in daily file)`,
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Content to store. Use markdown formatting for rich text.'
        },
        to_long_term: {
          type: 'boolean',
          description: 'If true, appends to MEMORY.md. If false, appends to daily file.',
          default: false
        }
      },
      required: ['content']
    }
  },
  {
    name: 'memory_list_recent',
    description: `Get recent conversation context and relevant long-term memories.

WHEN TO USE:
- At the start of a new conversation to load recent context
- To understand what happened in recent interactions
- To build continuity across conversation sessions
- To refresh working memory after a break

WHAT IT RETURNS:
- Recent memories from the past N days
- Chronologically ordered with newest first

PARAMETERS:
- days: How many recent days to include (default: 2)`,
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of recent days to include',
          default: 2
        }
      }
    }
  },
  {
    name: 'memory_forget',
    description: `Delete memories matching a query or specific file path.

WHEN TO USE:
- When user asks to forget or delete information
- To remove outdated or incorrect information
- To clean up superseded memories
- To respect privacy requests for data removal

WHAT IT RETURNS:
- Preview of memories that would be deleted (if confirm=false)
- Confirmation of deletion (if confirm=true)
- Count of deleted entries

SAFETY FEATURES:
- Requires confirm=true to actually delete
- First call with confirm=false shows preview
- Path-based deletion for specific files

PARAMETERS:
- query: Search query to find memories to delete
- path: Optional specific file path to delete
- confirm: Must be true to actually delete (default: false for safety)`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find memories to delete'
        },
        path: {
          type: 'string',
          description: 'Optional: specific file path to delete instead of searching'
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to actually delete. False shows preview only.',
          default: false
        }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_status',
    description: `Get memory system status and statistics.

WHEN TO USE:
- To check if the memory system is working
- To see how much information has been stored
- For debugging or troubleshooting
- To understand memory usage patterns

WHAT IT RETURNS:
- Total number of memories stored
- Total number of indexed chunks
- Memory directory location
- Database file location
- Configuration settings

USEFUL FOR:
- Verifying system initialization
- Monitoring growth over time
- Debugging search or storage issues
- Understanding system configuration`,
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
];

/**
 * Type definition for tool handlers
 */
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Tool handler implementations
 */
export const toolHandlers: Record<string, ToolHandler> = {
  /**
   * Search memories using hybrid semantic + keyword search
   */
  memory_search: async (args: Record<string, unknown>) => {
    try {
      const config = getConfig();
      const query = args.query as string;
      const minScore = (args.min_score as number) || 0.35;

      if (!query || typeof query !== 'string') {
        throw new Error('Query parameter is required and must be a string');
      }

      const hasTimeRange = inferTimeRangeMention(query);
      const defaultMaxResults = Number.isFinite(config.maxDailyChats)
        ? config.maxDailyChats
        : 180;
      const rawMaxResults = args.max_results ?? (hasTimeRange ? 6 : defaultMaxResults);
      const parsedMaxResults = Number(rawMaxResults);
      const maxResults = Number.isFinite(parsedMaxResults) && parsedMaxResults > 0
        ? Math.floor(parsedMaxResults)
        : defaultMaxResults;

      const dbPath = getDatabasePath(config.memoryDir);
      const db = createDatabase(dbPath);
      initSchema(db, getEmbeddingDimension(config.embeddingProvider));

      // Generate embedding for query
      const [queryEmbedding] = await generateEmbeddings(
        [query],
        getEmbeddingConfig(config)
      );

      // Perform hybrid search
      const results = await hybridSearch(db, query, queryEmbedding, {
        maxResults,
        minScore,
      });

      db.close();

      if (results.length === 0) {
        return {
          success: true,
          results: '',
          message: 'No memories found matching your query. Try different keywords or lower the min_score parameter.'
        };
      }

      const formattedResults = formatSearchResults(
        results.map(r => ({
          content: r.text,
          score: r.score,
          path: r.path,
          lineStart: r.startLine,
          lineEnd: r.endLine,
          supersededBy: r.supersededBy,
          supersedes: r.supersedes,
          conflictReason: r.conflictReason
        }))
      );

      return {
        success: true,
        results: formattedResults,
        count: results.length
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  },

  /**
   * Read specific lines from a memory file
   */
  memory_get: async (args: Record<string, unknown>) => {
    const relativePath = args.path as string;
    const fromLine = (args.from_line as number) || 1;
    const numLines = (args.lines as number) || 15;

    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Path parameter is required and must be a string');
    }

    try {
      const config = getConfig();
      const memoryDir = config.memoryDir;
      const fullPath = path.join(memoryDir, relativePath);

      // Security check: ensure path is within memory directory
      const resolvedPath = path.resolve(fullPath);
      const resolvedMemoryDir = path.resolve(memoryDir);
      if (!resolvedPath.startsWith(resolvedMemoryDir)) {
        throw new Error('Invalid path: must be within memory directory');
      }

      // Read file
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      // Validate line numbers
      if (fromLine < 1 || fromLine > lines.length) {
        throw new Error(`Invalid from_line: must be between 1 and ${lines.length}`);
      }

      // Extract requested lines (1-indexed)
      const startIdx = fromLine - 1;
      const endIdx = Math.min(startIdx + numLines, lines.length);
      const selectedLines = lines.slice(startIdx, endIdx);
      const rawContent = selectedLines.join('\n');
      const lineInfo = { fromLine, toLine: startIdx + selectedLines.length, totalLines: lines.length };
      const formattedContent = formatMemoryGet(rawContent, relativePath, lineInfo);

      return {
        success: true,
        content: formattedContent,
        truncated: endIdx < lines.length
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          success: false,
          error: `File not found: ${relativePath}`
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  },

  /**
   * Store new memory with deduplication and indexing
   */
  memory_store: async (args: Record<string, unknown>) => {
    const content = args.content as string;
    const toLongTerm = args.to_long_term === true;

    if (!content || typeof content !== 'string') {
      throw new Error('Content parameter is required and must be a string');
    }

    try {
      const config = getConfig();
      ensureMemoryDir(config.memoryDir);

      const dbPath = getDatabasePath(config.memoryDir);
      const db = createDatabase(dbPath);
      initSchema(db, getEmbeddingDimension(config.embeddingProvider));

      // Determine target file
      let targetPath: string;
      if (toLongTerm) {
        targetPath = getMemoryFilePath(config.memoryDir);
      } else {
        // Daily file
        const today = new Date().toISOString().split('T')[0];
        const memorySubDir = path.join(config.memoryDir, 'memory');
        if (!existsSync(memorySubDir)) {
          mkdirSync(memorySubDir, { recursive: true });
        }
        targetPath = path.join(memorySubDir, `${today}.md`);
      }

      const relativePath = path.relative(config.memoryDir, targetPath);

      // Append to file
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      const formattedContent = `\n## ${timestamp}\n\n${content}\n`;

      if (existsSync(targetPath)) {
        const existing = readFileSync(targetPath, 'utf-8');
        writeFileSync(targetPath, existing + formattedContent, 'utf-8');
      } else {
        const header = toLongTerm ? '' : `# ${new Date().toISOString().split('T')[0]}\n`;
        writeFileSync(targetPath, header + formattedContent, 'utf-8');
      }

      // Read updated file for indexing
      const fileContent = readFileSync(targetPath, 'utf-8');

      // Remove existing chunks for this file
      deleteChunksByPath(db, relativePath);

      // Chunk and embed the content
      const chunks = chunkText(fileContent);

      if (chunks.length > 0) {
        const texts = chunks.map(c => c.text);
        const embeddings = await generateEmbeddings(
          texts,
          getEmbeddingConfig(config)
        );

        // Insert chunks with embeddings
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const chunkId = `${relativePath}:${chunk.startLine}-${chunk.endLine}`;
          const contentHash = hashContent(chunk.text);

          insertChunk(db, {
            id: chunkId,
            path: relativePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            text: chunk.text,
            hash: contentHash,
            embedding: embeddings[i],
          });
        }
      }

      db.close();

      return {
        success: true,
        path: relativePath,
        chunks: chunks.length,
        message: 'Memory stored successfully'
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  },

  /**
   * Get recent conversation context
   */
  memory_list_recent: async (args: Record<string, unknown>) => {
    const days = (args.days as number) || 2;
    const maxAttempts = 2;
    const baseDelayMs = 200;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const config = getConfig();
        const dbPath = getDatabasePath(config.memoryDir);
        const db = createDatabase(dbPath);
        try {
          initSchema(db, getEmbeddingDimension(config.embeddingProvider));

          // Get recent memories
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - days);

          const recentMemories = getRecentMemories(db, cutoffDate.toISOString());

          const formattedMemories = formatRecentMemories(
            recentMemories.map(m => ({
              content: m.text,
              path: m.path,
              lineStart: m.startLine,
              lineEnd: m.endLine
            }))
          );

          return {
            success: true,
            context: formattedMemories,
            count: recentMemories.length,
            daysIncluded: days
          };
        } finally {
          db.close();
        }
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await delay(baseDelayMs * attempt);
          continue;
        }
      }
    }

    return {
      success: false,
      error: lastError instanceof Error ? lastError.message : String(lastError)
    };
  },

  /**
   * Delete memories by query or path
   */
  memory_forget: async (args: Record<string, unknown>) => {
    const query = args.query as string;
    const specificPath = args.path as string | undefined;
    const confirm = args.confirm === true;

    if (!query || typeof query !== 'string') {
      throw new Error('Query parameter is required and must be a string');
    }

    try {
      const config = getConfig();
      const dbPath = getDatabasePath(config.memoryDir);
      const db = createDatabase(dbPath);
      initSchema(db, getEmbeddingDimension(config.embeddingProvider));

      let memoriesToDelete: Array<{ path: string; text: string }> = [];

      if (specificPath) {
        // Delete specific path
        const chunks = getChunksByPath(db, specificPath);
        if (chunks.length > 0) {
          memoriesToDelete = [{ path: specificPath, text: chunks[0].text }];
        }
      } else {
        // Search for memories to delete
        const [queryEmbedding] = await generateEmbeddings(
          [query],
          getEmbeddingConfig(config)
        );

        const searchResults = await hybridSearch(db, query, queryEmbedding, {
          maxResults: 50,
          minScore: 0.5
        });

        memoriesToDelete = searchResults.map(r => ({
          path: r.path,
          text: r.text
        }));
      }

      if (memoriesToDelete.length === 0) {
        db.close();
        return {
          success: true,
          preview: [],
          message: 'No memories found matching the query'
        };
      }

      // Preview mode: show what would be deleted
      if (!confirm) {
        db.close();
        return {
          success: true,
          preview: memoriesToDelete.map(m => ({
            path: m.path,
            contentPreview: m.text.slice(0, 200) + (m.text.length > 200 ? '...' : '')
          })),
          count: memoriesToDelete.length,
          message: `Found ${memoriesToDelete.length} memories. Set confirm=true to delete them.`
        };
      }

      // Actual deletion
      const deletedPaths: string[] = [];
      const uniquePaths = [...new Set(memoriesToDelete.map(m => m.path))];

      for (const memoryPath of uniquePaths) {
        // Delete from database
        deleteMemoryByPath(db, memoryPath);

        // Delete file
        const fullPath = path.join(config.memoryDir, memoryPath);
        try {
          await fs.unlink(fullPath);
          deletedPaths.push(memoryPath);
        } catch {
          // File might not exist, still count as deleted from db
          deletedPaths.push(memoryPath);
        }
      }

      db.close();

      return {
        success: true,
        deleted: deletedPaths,
        count: deletedPaths.length,
        message: `Successfully deleted ${deletedPaths.length} memories`
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  },

  /**
   * Get memory system status and statistics
   */
  memory_status: async () => {
    try {
      const config = getConfig();
      const dbPath = getDatabasePath(config.memoryDir);
      const db = createDatabase(dbPath);
      initSchema(db, getEmbeddingDimension(config.embeddingProvider));

      const stats = getMemoryStats(db);
      const allPaths = getAllPaths(db);

      db.close();

      return {
        success: true,
        status: 'operational',
        statistics: {
          totalMemories: stats.totalMemories,
          totalChunks: stats.totalChunks,
          files: allPaths
        },
        configuration: {
          memoryDir: config.memoryDir,
          databasePath: dbPath,
          embeddingModel: config.embeddingModel,
          maintenance: config.maintenance
        }
      };
    } catch (error) {
      return {
        success: false,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  },

};
