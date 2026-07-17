/**
 * Compute Word Error Rate between hypothesis and reference.
 * Uses Levenshtein distance on word sequences.
 * @param hypothesis
 * @param reference
 * @returns WER as a ratio (0.0 = perfect, 1.0 = 100% errors)
 */
export declare function computeWER(hypothesis: string, reference: string): number;
