export interface Language {
  code: string; // ISO 639-1 code
  language: string; // Language name
}

export interface LanguageProbability {
  code: string; // ISO 639-1 code
  language: string; // Language name
  probability: number; // Probability of the language being detected
}

/**
 * Detects the most probable language for a given text.
 * @param {string} text The text to analyze.
 * @returns {Language} The most probable language.
 */
export declare function detectOne(text: string): Language;

/**
 * Detect multiple probable languages for a given text.
 * @param {string} text The text to analyze.
 * @param {number} topK Number of top probable languages to return.
 * @returns {LanguageProbability[]} A list of probable languages with probabilities.
 */
export declare function detectMultiple(
  text: string,
  topK?: number
): LanguageProbability[];

/**
 * Gets the language name from either an ISO2 or ISO3 language code.
 * @param {string} code The ISO2 or ISO3 language code.
 * @returns {string | null} The language name or null if code is not found.
 */
export declare function getLangName(code: string): string | null;

/**
 * Gets the ISO2 code from a language name.
 * @param {string} languageName The language name.
 * @returns {string | null} The ISO2 code or null if language name is not found.
 */
export declare function getISO2FromName(languageName: string): string | null;
