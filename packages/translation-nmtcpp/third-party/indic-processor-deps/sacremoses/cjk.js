/**
 * This module provides functions to detect CJK (Chinese, Japanese, Korean) characters
 * based on their Unicode code points.
 */

/**
 * CJKChars class that enumerates the code points of CJK characters
 * as listed on http://en.wikipedia.org/wiki/Basic_Multilingual_Plane#Basic_Multilingual_Plane
 */
class CJKChars {
  constructor () {
    // Hangul Jamo (1100–11FF)
    this.Hangul_Jamo = [0x1100, 0x11ff]

    // CJK Radicals Supplement (2E80–2EFF)
    // Kangxi Radicals (2F00–2FDF)
    // Ideographic Description Characters (2FF0–2FFF)
    // CJK Symbols and Punctuation (3000–303F)
    // Hiragana (3040–309F)
    // Katakana (30A0–30FF)
    // Bopomofo (3100–312F)
    // Hangul Compatibility Jamo (3130–318F)
    // Kanbun (3190–319F)
    // Bopomofo Extended (31A0–31BF)
    // CJK Strokes (31C0–31EF)
    // Katakana Phonetic Extensions (31F0–31FF)
    // Enclosed CJK Letters and Months (3200–32FF)
    // CJK Compatibility (3300–33FF)
    // CJK Unified Ideographs Extension A (3400–4DBF)
    // Yijing Hexagram Symbols (4DC0–4DFF)
    // CJK Unified Ideographs (4E00–9FFF)
    // Yi Syllables (A000–A48F)
    // Yi Radicals (A490–A4CF)
    this.CJK_Radicals = [0x2e80, 0xa4cf]

    // Phags-pa (A840–A87F)
    this.Phags_Pa = [0xa840, 0xa87f]

    // Hangul Syllables (AC00–D7AF)
    this.Hangul_Syllables = [0xac00, 0xd7af]

    // CJK Compatibility Ideographs (F900–FAFF)
    this.CJK_Compatibility_Ideographs = [0xf900, 0xfaff]

    // CJK Compatibility Forms (FE30–FE4F)
    this.CJK_Compatibility_Forms = [0xfe30, 0xfe4f]

    // Range U+FF65–FFDC encodes halfwidth forms, of Katakana and Hangul characters
    this.Katakana_Hangul_Halfwidth = [0xff65, 0xffdc]

    // Ideographic Symbols and Punctuation (16FE0–16FFF)
    this.Ideographic_Symbols_And_Punctuation = [0x16fe0, 0x16fff]

    // Tangut (17000-187FF)
    // Tangut Components (18800-18AFF)
    this.Tangut = [0x17000, 0x18aff]

    // Kana Supplement (1B000-1B0FF)
    // Kana Extended-A (1B100-1B12F)
    this.Kana_Supplement = [0x1b000, 0x1b12f]

    // Nushu (1B170-1B2FF)
    this.Nushu = [0x1b170, 0x1b2ff]

    // Supplementary Ideographic Plane (20000–2FFFF)
    this.Supplementary_Ideographic_Plane = [0x20000, 0x2ffff]

    // Collect all ranges in a single array
    this.ranges = [
      this.Hangul_Jamo,
      this.CJK_Radicals,
      this.Phags_Pa,
      this.Hangul_Syllables,
      this.CJK_Compatibility_Ideographs,
      this.CJK_Compatibility_Forms,
      this.Katakana_Hangul_Halfwidth,
      this.Ideographic_Symbols_And_Punctuation,
      this.Tangut,
      this.Kana_Supplement,
      this.Nushu,
      this.Supplementary_Ideographic_Plane
    ]
  }
}

// Create a singleton instance of CJKChars
const cjkCharsRanges = new CJKChars().ranges

/**
 * Checks if a character is a CJK (Chinese, Japanese, Korean) character
 *
 * @param {string} character - The character to check (must be a single character)
 * @returns {boolean} - True if the character is a CJK character, false otherwise
 *
 * @example
 * isCJK('世'); // true
 * isCJK('A'); // false
 * isCJK('ひ'); // true (Hiragana)
 * isCJK('カ'); // true (Katakana)
 * isCJK('한'); // true (Hangul)
 */
function isCJK (character) {
  // Check that we've got a single character
  if (character.length !== 1) {
    throw new Error('isCJK requires a single character as input')
  }

  // Get the Unicode code point of the character
  const codePoint = character.codePointAt(0)

  // Check if the code point falls within any of the CJK ranges
  for (const [start, end] of cjkCharsRanges) {
    if (codePoint < end) {
      return codePoint >= start
    }
  }

  return false
}

/**
 * Checks if a string contains any CJK characters
 *
 * @param {string} text - The string to check
 * @returns {boolean} - True if the string contains any CJK characters, false otherwise
 *
 * @example
 * containsCJK('Hello 世界'); // true
 * containsCJK('Hello world'); // false
 */
function containsCJK (text) {
  for (let i = 0; i < text.length; i++) {
    // Handle surrogate pairs correctly for characters outside BMP
    const char = text.charAt(i)

    // Skip high surrogate if it's part of a surrogate pair
    if (
      i < text.length - 1 &&
      char.charCodeAt(0) >= 0xd800 &&
      char.charCodeAt(0) <= 0xdbff
    ) {
      const pair = text.substring(i, i + 2)
      if (isCJK(pair)) {
        return true
      }
      i++ // Skip the low surrogate in the next iteration
      continue
    }

    if (isCJK(char)) {
      return true
    }
  }

  return false
}

/**
 * Counts the number of CJK characters in a string
 *
 * @param {string} text - The string to check
 * @returns {number} - The count of CJK characters in the string
 *
 * @example
 * countCJKChars('Hello 世界'); // 2
 * countCJKChars('Hello world'); // 0
 */
function countCJKChars (text) {
  let count = 0

  for (let i = 0; i < text.length; i++) {
    // Handle surrogate pairs correctly for characters outside BMP
    const char = text.charAt(i)

    // Skip high surrogate if it's part of a surrogate pair
    if (
      i < text.length - 1 &&
      char.charCodeAt(0) >= 0xd800 &&
      char.charCodeAt(0) <= 0xdbff
    ) {
      const pair = text.substring(i, i + 2)
      if (isCJK(pair)) {
        count++
      }
      i++ // Skip the low surrogate in the next iteration
      continue
    }

    if (isCJK(char)) {
      count++
    }
  }

  return count
}

module.exports = {
  CJKChars,
  isCJK,
  containsCJK,
  countCJKChars
}
