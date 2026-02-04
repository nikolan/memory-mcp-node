/**
 * Shared text utility functions for similarity comparison and deduplication.
 */

/**
 * Extract words (>2 chars) from text for similarity comparison.
 * Lowercases and filters short words to focus on meaningful content.
 */
export function extractWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2)
  );
}

/**
 * Calculate Jaccard similarity between two texts.
 * Jaccard index = |A ∩ B| / |A ∪ B|
 * Returns a value between 0 (completely different) and 1 (identical).
 */
export function jaccardSimilarity(text1: string, text2: string): number {
  const words1 = extractWords(text1);
  const words2 = extractWords(text2);

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Check if a text is a duplicate of any text in a list.
 * Uses Jaccard similarity with the given threshold.
 */
export function isDuplicateOf(
  text: string,
  existingTexts: string[],
  threshold: number = 0.85
): boolean {
  return existingTexts.some(existing => jaccardSimilarity(text, existing) > threshold);
}
