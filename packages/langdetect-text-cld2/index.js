import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const cld = require('cld')
const tags = require('language-tags')

/**
 * @typedef {Object} Language
 * @property {string} code - ISO 639-1/2/3 code.
 * @property {string} language - The language name.
 */

/**
 * @typedef {Object} LanguageProbability
 * @property {string} code - ISO 639-1/2/3 code.
 * @property {string} language - The language name.
 * @property {number} probability - The probability of the language being detected.
 */

/**
 * Convert CLD2 language code to ISO 639 code
 * Returns ISO 639-1 if available, otherwise ISO 639-2/3
 * @param {string} cldCode The CLD2 language code
 * @returns {string} ISO 639-1/2/3 code or 'und' if not found
 */
function cldToISO (cldCode) {
  if (!cldCode) return 'und'

  const code = cldCode.toLowerCase()

  const specialCases = {
    'zh-hant': 'zh', // Traditional Chinese
    'zh-hans': 'zh', // Simplified Chinese
    iw: 'he', // Hebrew (CLD2 sometimes uses old code)
    in: 'id', // Indonesian (CLD2 sometimes uses old code)
    jw: 'jv', // Javanese
    mo: 'ro', // Moldovan -> Romanian
    sh: 'sr', // Serbo-Croatian -> Serbian
    un: 'und', // Unknown
    xxx: 'und' // Unknown
  }

  if (specialCases[code]) return specialCases[code]

  // Try to parse as a language tag
  const tag = tags(code)

  if (tag && tag.valid()) {
    const lang = tag.language()
    if (lang) {
      const subtag = lang.format()
      if (subtag) {
        return subtag
      }
    }
  }

  // Return the code as is if it's 2 or 3 letters, otherwise 'und'
  return (code.length === 2 || code.length === 3) ? code : 'und'
}

/**
 * Get language name from ISO code using language-tags
 * @param {string} isoCode ISO 639-1, 639-2, or 639-3 code
 * @returns {string} Language name
 */
function getLanguageName (isoCode) {
  if (!isoCode || isoCode === 'und') return 'Undetermined'

  const code = isoCode.toLowerCase()
  const tag = tags(code)

  if (tag && tag.valid()) {
    const lang = tag.language()
    if (lang && lang.descriptions) {
      const descriptions = lang.descriptions()
      if (descriptions && descriptions.length > 0) {
        return descriptions[0]
      }
    }
  }

  return 'Unknown'
}

/**
 * Detects the most probable language for a given text.
 * @param {string} text The text to analyze.
 * @returns {Promise<Object>} The detected language or `Undetermined` if no language is detected.
 */
async function detectOne (text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return {
      code: 'und',
      language: 'Undetermined'
    }
  }

  let result
  try {
    result = await cld.detect(text)
  } catch (error) {
    // CLD2 throws an error if it can't detect the language
    return {
      code: 'und',
      language: 'Undetermined'
    }
  }

  if (!result || !result.languages || result.languages.length === 0) {
    return {
      code: 'und',
      language: 'Undetermined'
    }
  }

  const topLanguage = result.languages[0]
  const isoCode = cldToISO(topLanguage.code)

  return {
    code: isoCode,
    language: getLanguageName(isoCode)
  }
}

/**
 * Detect multiple probable languages for a given text.
 * @param {string} text The text to analyze.
 * @param {number} topK Number of top probable languages to return.
 * @returns {Promise<Array>} A list of probable languages with probabilities.
 */
async function detectMultiple (text, topK = 3) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return [{
      code: 'und',
      language: 'Undetermined',
      probability: 1
    }]
  }

  if (typeof topK !== 'number' || topK <= 0) {
    topK = 3
  }

  let result
  try {
    result = await cld.detect(text)
  } catch (error) {
    return [{
      code: 'und',
      language: 'Undetermined',
      probability: 1
    }]
  }

  if (!result || !result.languages || result.languages.length === 0) {
    return [{
      code: 'und',
      language: 'Undetermined',
      probability: 1
    }]
  }

  // CLD2 returns languages with percent field
  const languages = result.languages.slice(0, topK).map(lang => {
    const isoCode = cldToISO(lang.code)
    return {
      code: isoCode,
      language: getLanguageName(isoCode),
      probability: lang.percent / 100 // Convert percent to probability (0-1)
    }
  })

  return languages
}

/**
 * Gets the language name from either an ISO2 or ISO3 language code.
 * @param {string} code The ISO2 or ISO3 language code.
 * @returns {string | null} The language name or null if code is not found.
 */
function getLangName (code) {
  if (typeof code !== 'string' || code.trim().length === 0) {
    return null
  }

  const normalizedCode = code.trim().toLowerCase()

  const tag = tags(normalizedCode)

  if (tag && tag.valid()) {
    const lang = tag.language()
    if (lang && lang.descriptions) {
      const descriptions = lang.descriptions()
      if (descriptions && descriptions.length > 0) {
        return descriptions[0]
      }
    }
  }

  return null
}

/**
 * Gets the ISO2 code from a language name.
 * @param {string} languageName The language name.
 * @returns {string | null} The ISO2 code or null if language name is not found.
 */
function getISO2FromName (languageName) {
  if (typeof languageName !== 'string' || languageName.trim().length === 0) {
    return null
  }

  const normalizedName = languageName.trim()
  const searchResults = tags.search(normalizedName)

  if (searchResults && searchResults.length > 0) {
    for (const result of searchResults) {
      // Check if it's a language type and has a 2-letter code
      if (result && result.data && result.data.type === 'language') {
        const subtag = result.format()
        if (subtag && subtag.length === 2) {
          return subtag
        }
      }
    }
  }

  return null
}

export {
  detectOne,
  detectMultiple,
  getLangName,
  getISO2FromName
}
