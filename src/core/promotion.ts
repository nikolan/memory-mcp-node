import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { getUnpromotedChunks, markChunksAsPromoted, markSupersedes, getChunksByCategory } from './database.js';
import { getMemoryFilePath } from './config.js';
import { chunkText, hashContent, generateEmbeddings, type EmbeddingConfig } from './indexer.js';
import { insertChunk, deleteChunksByPath } from './database.js';
import { callLLM, type LLMConfig } from './llm.js';
import { jaccardSimilarity } from './textUtils.js';

export interface PromotionScore {
  score: number;
  category: string;
  summary: string;
}

export interface PromotionCandidate {
  chunkId: string;
  path: string;
  text: string;
  score: number;
  category: string;
  summary: string;
}

export interface PromotionResult {
  promoted: PromotionCandidate[];
  skipped: number;
  errors: string[];
}

export interface CleanupResult {
  sectionsRemoved: number;
  bytesReduced: number;
  detailsStripped: number;
}

export interface ConflictDetection {
  conflictsWith: string | null;
  reason: 'updates' | 'corrects' | 'contradicts' | null;
  confidence: number;
}

const CONFLICT_DETECTION_PROMPT = `Compare this new memory entry against existing entries in the same category.

NEW ENTRY:
{NEW_ENTRY}

EXISTING ENTRIES:
{EXISTING_ENTRIES}

Does the new entry UPDATE, CORRECT, or CONTRADICT any existing entry?
- UPDATE: Same topic, newer information (e.g., "now uses pnpm" updates "uses npm")
- CORRECT: Fixes a mistake (e.g., "actually prefers tabs" corrects "prefers spaces")
- CONTRADICT: Incompatible facts that need resolution

Respond with JSON only (no markdown, no explanation):
{"conflicts": false} or {"conflicts": true, "index": <number>, "reason": "updates|corrects|contradicts", "confidence": 0.0-1.0}`;

const SCORING_PROMPT = `Analyze this memory entry and score its long-term relevance (0-1):
- 0.9+: Core user identity, preferences, important decisions, key personal information
- 0.7-0.9: Important facts, recurring themes, significant events
- 0.5-0.7: Useful context that may become relevant later
- <0.5: Transient conversation, temporary notes, debugging sessions, not worth preserving long-term

Consider:
1. Is this about the user's identity, preferences, or important decisions?
2. Is this factual information that would be useful to remember?
3. Is this about important people, projects, or systems?
4. Would this still be relevant in 6 months?

Memory entry to analyze:
"""
{CONTENT}
"""

Return JSON only (no markdown, no explanation):
{"score": number, "category": "preferences" | "decisions" | "contacts" | "facts" | "context" | "transient", "summary": "1-2 sentence summary if worth promoting"}`;

/**
 * Detects conflicts between a new chunk and existing MEMORY.md entries in the same category
 */
export async function detectConflicts(
  db: Database.Database,
  newChunkText: string,
  newChunkId: string,
  category: string,
  llmConfig: LLMConfig
): Promise<ConflictDetection> {
  // Get existing chunks from MEMORY.md in the same category
  // For now, we'll get all MEMORY.md chunks and let LLM filter by category
  const existingChunks = getChunksByCategory(db, category, newChunkId);

  if (existingChunks.length === 0) {
    return { conflictsWith: null, reason: null, confidence: 0 };
  }

  // Build prompt with existing entries
  const existingEntriesText = existingChunks
    .map((c, i) => `[${i}] ${c.text}`)
    .join('\n\n');

  const prompt = CONFLICT_DETECTION_PROMPT
    .replace('{NEW_ENTRY}', newChunkText)
    .replace('{EXISTING_ENTRIES}', existingEntriesText);

  try {
    const response = await callLLM(llmConfig, prompt, {
      temperature: 0.1,
      maxTokens: 200,
    });

    if (!response.content) {
      return { conflictsWith: null, reason: null, confidence: 0 };
    }

    const parsed = JSON.parse(response.content);

    if (!parsed.conflicts) {
      return { conflictsWith: null, reason: null, confidence: 0 };
    }

    const index = parsed.index;
    if (typeof index !== 'number' || index < 0 || index >= existingChunks.length) {
      return { conflictsWith: null, reason: null, confidence: 0 };
    }

    const conflictingChunk = existingChunks[index];
    const reason = parsed.reason;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

    if (!['updates', 'corrects', 'contradicts'].includes(reason)) {
      return { conflictsWith: null, reason: null, confidence: 0 };
    }

    return {
      conflictsWith: conflictingChunk.id,
      reason: reason as 'updates' | 'corrects' | 'contradicts',
      confidence,
    };
  } catch (error) {
    // On error, assume no conflict
    return { conflictsWith: null, reason: null, confidence: 0 };
  }
}

/**
 * Scores a chunk for long-term relevance using configured LLM provider
 */
async function scoreChunk(
  text: string,
  llmConfig: LLMConfig
): Promise<PromotionScore> {
  const prompt = SCORING_PROMPT.replace('{CONTENT}', text);

  try {
    const response = await callLLM(llmConfig, prompt, {
      temperature: 0.1,
      maxTokens: 200,
    });

    if (!response.content) {
      throw new Error('Empty response from LLM');
    }

    // Parse JSON response
    const parsed = JSON.parse(response.content);
    return {
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      category: parsed.category || 'transient',
      summary: parsed.summary || '',
    };
  } catch (error) {
    // Default to low score on error
    return {
      score: 0,
      category: 'transient',
      summary: '',
    };
  }
}

/**
 * Gets the appropriate section header in MEMORY.md for a category
 */
function getSectionHeader(category: string): string {
  const sections: Record<string, string> = {
    preferences: '## User Preferences',
    decisions: '## Important Decisions',
    contacts: '## Key Contacts',
    facts: '## Key Facts',
    context: '## Important Context',
  };
  return sections[category] || '## Important Context';
}

/**
 * Appends promoted content to the appropriate section in MEMORY.md
 */
function appendToMemorySection(
  memoryFilePath: string,
  category: string,
  summary: string,
  originalText: string
): void {
  let content = '';
  if (fs.existsSync(memoryFilePath)) {
    content = fs.readFileSync(memoryFilePath, 'utf-8');
  }

  const sectionHeader = getSectionHeader(category);
  const dateStr = new Date().toISOString().split('T')[0];
  const entryContent = `\n### ${dateStr}\n\n${summary}\n\n**Context:**\n${originalText}\n`;

  // Find the section and append after it
  const sectionIndex = content.indexOf(sectionHeader);
  if (sectionIndex !== -1) {
    // Find the next section (## header) or end of file
    const nextSectionMatch = content.slice(sectionIndex + sectionHeader.length).match(/\n## /);
    const insertPosition = nextSectionMatch
      ? sectionIndex + sectionHeader.length + (nextSectionMatch.index ?? 0)
      : content.length;

    content = content.slice(0, insertPosition) + entryContent + content.slice(insertPosition);
  } else {
    // Section doesn't exist, add it at the end
    content += `\n${sectionHeader}\n${entryContent}`;
  }

  fs.writeFileSync(memoryFilePath, content, 'utf-8');
}

/**
 * Re-indexes MEMORY.md after promotion
 */
export async function reindexMemoryFile(
  db: Database.Database,
  memoryFilePath: string,
  memoryDir: string,
  embeddingConfig: EmbeddingConfig
): Promise<void> {
  const content = fs.readFileSync(memoryFilePath, 'utf-8');
  const relativePath = path.relative(memoryDir, memoryFilePath);

  // Remove existing chunks
  deleteChunksByPath(db, relativePath);

  // Re-chunk and embed
  const chunks = chunkText(content);
  if (chunks.length === 0) return;

  const texts = chunks.map(c => c.text);
  const embeddings = await generateEmbeddings(texts, embeddingConfig);

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

/**
 * Identifies candidates for promotion without making changes
 */
export async function identifyPromotionCandidates(
  db: Database.Database,
  lookbackDays: number,
  scoreThreshold: number,
  llmConfig: LLMConfig
): Promise<{
  candidates: PromotionCandidate[];
  totalAnalyzed: number;
  skippedDuplicates: number;
}> {
  const chunks = getUnpromotedChunks(db, lookbackDays);
  const candidates: PromotionCandidate[] = [];
  const candidateTexts: string[] = [];
  let skippedDuplicates = 0;

  for (const chunk of chunks) {
    // Skip duplicates of already-identified candidates
    if (isDuplicateOfPromoted(chunk.text, candidateTexts, 0.85)) {
      skippedDuplicates++;
      continue;
    }

    const score = await scoreChunk(chunk.text, llmConfig);

    if (score.score >= scoreThreshold) {
      candidates.push({
        chunkId: chunk.id,
        path: chunk.path,
        text: chunk.text,
        score: score.score,
        category: score.category,
        summary: score.summary,
      });
      candidateTexts.push(chunk.text);
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  return {
    candidates,
    totalAnalyzed: chunks.length,
    skippedDuplicates,
  };
}

/**
 * Checks if a chunk is too similar to already-promoted content
 */
function isDuplicateOfPromoted(
  text: string,
  promotedTexts: string[],
  threshold: number = 0.85
): boolean {
  for (const promoted of promotedTexts) {
    if (jaccardSimilarity(text, promoted) >= threshold) {
      return true;
    }
  }
  return false;
}

/**
 * Extract text content from existing MEMORY.md sections for dedup comparison.
 */
function extractExistingPromotedContent(memoryFilePath: string): string[] {
  if (!fs.existsSync(memoryFilePath)) return [];
  const content = fs.readFileSync(memoryFilePath, 'utf-8');
  const sections = content.split(/^### /m).filter(Boolean);
  return sections.map(s => s.replace(/^[^\n]+\n/, '').trim());
}

/**
 * Promotes high-scoring chunks to MEMORY.md
 */
export async function promoteToLongTerm(
  db: Database.Database,
  memoryDir: string,
  lookbackDays: number = 30,
  scoreThreshold: number = 0.8,
  llmConfig: LLMConfig,
  embeddingConfig: EmbeddingConfig,
  dryRun: boolean = false
): Promise<PromotionResult> {
  const result: PromotionResult = {
    promoted: [],
    skipped: 0,
    errors: [],
  };

  const chunks = getUnpromotedChunks(db, lookbackDays);
  const memoryFilePath = getMemoryFilePath(memoryDir);

  // Track promoted texts to avoid duplicates within the same run
  const promotedTexts: string[] = [];
  const existingTexts = extractExistingPromotedContent(memoryFilePath);

  for (const chunk of chunks) {
    try {
      // Skip if too similar to already-promoted content in this run or in existing MEMORY.md
      if (isDuplicateOfPromoted(chunk.text, [...promotedTexts, ...existingTexts], 0.85)) {
        result.skipped++;
        // Mark as promoted anyway to avoid re-processing
        if (!dryRun) {
          markChunksAsPromoted(db, [chunk.id]);
        }
        continue;
      }

      const score = await scoreChunk(chunk.text, llmConfig);

      if (score.score >= scoreThreshold) {
        const candidate: PromotionCandidate = {
          chunkId: chunk.id,
          path: chunk.path,
          text: chunk.text,
          score: score.score,
          category: score.category,
          summary: score.summary,
        };

        if (!dryRun) {
          // Detect conflicts before appending
          const conflict = await detectConflicts(
            db,
            chunk.text,
            chunk.id,
            score.category,
            llmConfig
          );

          // Append to MEMORY.md
          appendToMemorySection(
            memoryFilePath,
            score.category,
            score.summary,
            chunk.text
          );

          // Mark as promoted
          markChunksAsPromoted(db, [chunk.id]);

          // If conflict detected with high confidence, mark supersession after re-indexing
          // We'll handle this after re-indexing in the batch below
          if (conflict.conflictsWith && conflict.confidence > 0.7) {
            // Store conflict info temporarily - we'll mark it after re-indexing
            (candidate as any).conflictInfo = conflict;
          }
        }

        result.promoted.push(candidate);
        promotedTexts.push(chunk.text);
      } else {
        result.skipped++;
        // Mark low-scoring chunks as promoted to avoid re-scoring
        if (!dryRun) {
          markChunksAsPromoted(db, [chunk.id]);
        }
      }
    } catch (error) {
      result.errors.push(
        `Error processing chunk ${chunk.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Re-index MEMORY.md after all promotions
  if (!dryRun && result.promoted.length > 0) {
    try {
      // Get existing MEMORY.md chunk IDs before re-indexing
      const existingMemoryChunkIds = new Set(
        getChunksByCategory(db, '', '').map(c => c.id)
      );

      await reindexMemoryFile(db, memoryFilePath, memoryDir, embeddingConfig);

      // Get new chunk IDs after re-indexing
      const allMemoryChunkIds = new Set(
        getChunksByCategory(db, '', '').map(c => c.id)
      );
      const newChunkIds = Array.from(allMemoryChunkIds).filter(
        id => !existingMemoryChunkIds.has(id)
      );

      // Mark supersession relationships for conflicts detected during promotion
      for (const candidate of result.promoted) {
        const conflictInfo = (candidate as any).conflictInfo as ConflictDetection | undefined;
        if (conflictInfo?.conflictsWith && conflictInfo.confidence > 0.7) {
          // Use the first new chunk ID as the superseding chunk
          // In practice, the new entry might create multiple chunks, so we mark all of them
          if (newChunkIds.length > 0) {
            const newChunkId = newChunkIds[0]; // Use first new chunk
            markSupersedes(db, newChunkId, conflictInfo.conflictsWith, conflictInfo.reason!);
            console.error(`→ Supersedes MEMORY.md:${conflictInfo.conflictsWith} (${conflictInfo.reason})`);
          }
        }
      }
    } catch (error) {
      result.errors.push(
        `Error re-indexing MEMORY.md: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return result;
}

/**
 * Gets promotion statistics
 */
export function getPromotionStats(
  db: Database.Database,
  lookbackDays: number
): {
  unpromotedCount: number;
  recentlyPromotedCount: number;
} {
  const unpromoted = getUnpromotedChunks(db, lookbackDays);

  // Count recently promoted (within lookback period)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM chunks
    WHERE promoted_at IS NOT NULL
      AND promoted_at >= ?
  `);
  const recentlyPromoted = (stmt.get(cutoffDate.toISOString()) as { count: number }).count;

  return {
    unpromotedCount: unpromoted.length,
    recentlyPromotedCount: recentlyPromoted,
  };
}

/**
 * Clean up an existing MEMORY.md file by:
 * 1. Stripping all <details> wrappers (flatten)
 * 2. Deduplicating sections with >85% Jaccard similarity
 */
export async function cleanupMemoryFile(memoryFilePath: string): Promise<CleanupResult> {
  if (!fs.existsSync(memoryFilePath)) {
    return { sectionsRemoved: 0, bytesReduced: 0, detailsStripped: 0 };
  }

  const content = fs.readFileSync(memoryFilePath, 'utf-8');
  const originalSize = content.length;
  let detailsStripped = 0;

  // 1. Iteratively strip all <details>...</details> wrappers (handles nested/malformed tags)
  let cleaned = content;
  let iterations = 0;
  const maxIterations = 10; // Safety limit
  while (cleaned.includes('<details>') && iterations < maxIterations) {
    const before = cleaned;
    cleaned = cleaned.replace(
      /<details>\s*<summary>[^<]*<\/summary>\s*([\s\S]*?)\s*<\/details>/g,
      (match, inner) => {
        detailsStripped++;
        return `**Context:**\n${inner.trim()}`;
      }
    );
    // If no change, try a more aggressive pattern for malformed tags
    if (cleaned === before) {
      cleaned = cleaned.replace(/<details>/g, '');
      cleaned = cleaned.replace(/<\/details>/g, '');
      cleaned = cleaned.replace(/<summary>[^<]*<\/summary>/g, '');
    }
    iterations++;
  }

  // 2. Parse into sections by ### headers
  const sections = cleaned.split(/(?=^### )/m).filter(Boolean);

  // 3. Deduplicate sections with >85% Jaccard similarity (keep longest)
  const unique: string[] = [];
  for (const section of sections) {
    const dupeIndex = unique.findIndex(u => jaccardSimilarity(u, section) > 0.85);
    if (dupeIndex === -1) {
      unique.push(section);
    } else {
      // Keep longer version
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
