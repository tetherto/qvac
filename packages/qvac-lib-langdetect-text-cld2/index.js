'use strict'

const cld = require('cld')
const isoLanguageCodes = require('iso-language-codes')

/**
 * @typedef {Object} Language
 * @property {string} code - ISO 639-1 code.
 * @property {string} language - The language name.
 */

/**
 * @typedef {Object} LanguageProbability
 * @property {string} code - ISO 639-1 code.
 * @property {string} language - The language name.
 * @property {number} probability - The probability of the language being detected.
 */

/**
 * Convert CLD2 language code to ISO 639-1
 * CLD2 returns codes in various formats (ISO 639-1, ISO 639-2, etc.)
 * @param {string} cldCode The CLD2 language code
 * @returns {string} ISO 639-1 code or 'und' if not found
 */
function cldToISO2(cldCode) {
  if (!cldCode) return 'und'
  
  const code = cldCode.toLowerCase()
  
  // CLD2 often returns ISO 639-1 codes directly
  // Try to find by alpha2 first
  if (isoLanguageCodes.by639_1[code]) {
    return code
  }
  
  // Try to find by alpha3 (ISO 639-2T)
  if (isoLanguageCodes.by639_2T[code]) {
    const lang = isoLanguageCodes.by639_2T[code]
    if (lang.iso639_1) return lang.iso639_1
  }
  
  // Try to find by alpha3 (ISO 639-2B)
  if (isoLanguageCodes.by639_2B[code]) {
    const lang = isoLanguageCodes.by639_2B[code]
    if (lang.iso639_1) return lang.iso639_1
  }
  
  // Handle special CLD2 cases
  const specialCases = {
    'zh-hant': 'zh', // Traditional Chinese
    'zh-hans': 'zh', // Simplified Chinese
    'tl': 'tl', // Tagalog (CLD2 uses tl, ISO uses tl/fil)
    'iw': 'he', // Hebrew (CLD2 sometimes uses old code)
    'in': 'id', // Indonesian (CLD2 sometimes uses old code)
    'jw': 'jv', // Javanese
    'mo': 'ro', // Moldovan -> Romanian
    'sh': 'sr', // Serbo-Croatian -> Serbian
    'un': 'und', // Unknown
    'xxx': 'und' // Unknown
  }
  
  if (specialCases[code]) return specialCases[code]
  
  // If no mapping found, return the original code if it's 2 chars, otherwise 'und'
  return code.length === 2 ? code : 'und'
}

/**
 * Get language name from ISO2 code using iso-language-codes
 * @param {string} iso2 ISO 639-1 code
 * @returns {string} Language name
 */
function getLanguageName(iso2) {
  if (!iso2 || iso2 === 'und') return 'Undetermined'
  
  try {
    const lang = isoLanguageCodes.by639_1[iso2.toLowerCase()]
    return lang ? lang.name : 'Unknown'
  } catch (error) {
    return 'Unknown'
  }
}

/**
 * Detects the most probable language for a given text.
 * @param {string} text The text to analyze.
 * @returns {Promise<Object>} The detected language or `Undetermined` if no language is detected.
 */
async function detectOne(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return {
      code: 'und',
      language: 'Undetermined'
    }
  }

  try {
    // CLD2 detect is asynchronous
    const result = await cld.detect(text)
    
    if (!result || !result.languages || result.languages.length === 0) {
      return {
        code: 'und',
        language: 'Undetermined'
      }
    }

    const topLanguage = result.languages[0]
    const iso2Code = cldToISO2(topLanguage.code)
    
    return {
      code: iso2Code,
      language: getLanguageName(iso2Code)
    }
  } catch (error) {
    // CLD2 throws an error if it can't detect the language
    return {
      code: 'und',
      language: 'Undetermined'
    }
  }
}

/**
 * Detect multiple probable languages for a given text.
 * @param {string} text The text to analyze.
 * @param {number} topK Number of top probable languages to return.
 * @returns {Promise<Array>} A list of probable languages with probabilities.
 */
async function detectMultiple(text, topK = 3) {
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

  try {
    const result = await cld.detect(text)
    
    if (!result || !result.languages || result.languages.length === 0) {
      return [{
        code: 'und',
        language: 'Undetermined',
        probability: 1
      }]
    }

    // CLD2 returns languages with percent field
    const languages = result.languages.slice(0, topK).map(lang => {
      const iso2Code = cldToISO2(lang.code)
      return {
        code: iso2Code,
        language: getLanguageName(iso2Code),
        probability: lang.percent / 100 // Convert percent to probability (0-1)
      }
    })
    
    return languages
  } catch (error) {
    return [{
      code: 'und',
      language: 'Undetermined',
      probability: 1
    }]
  }
}

/**
 * Gets the language name from either an ISO2 or ISO3 language code.
 * @param {string} code The ISO2 or ISO3 language code.
 * @returns {string | null} The language name or null if code is not found.
 */
function getLangName(code) {
  if (typeof code !== 'string' || code.trim().length === 0) {
    return null
  }

  const normalizedCode = code.trim().toLowerCase()

  try {
    // Try ISO2 first
    if (isoLanguageCodes.by639_1[normalizedCode]) {
      return isoLanguageCodes.by639_1[normalizedCode].name
    }
    
    // Try ISO3 (639-2T)
    if (isoLanguageCodes.by639_2T[normalizedCode]) {
      return isoLanguageCodes.by639_2T[normalizedCode].name
    }
    
    // Try ISO3 (639-2B)
    if (isoLanguageCodes.by639_2B[normalizedCode]) {
      return isoLanguageCodes.by639_2B[normalizedCode].name
    }
    
    return null
  } catch (error) {
    return null
  }
}

/**
 * Gets the ISO2 code from a language name.
 * @param {string} languageName The language name.
 * @returns {string | null} The ISO2 code or null if language name is not found.
 */
function getISO2FromName(languageName) {
  if (typeof languageName !== 'string' || languageName.trim().length === 0) {
    return null
  }

  const normalizedName = languageName.trim()
  
  try {
    // iso-language-codes.codes array contains all languages
    const allLanguages = isoLanguageCodes.codes
    
    // First try exact match (case-insensitive)
    const exactMatch = allLanguages.find(lang => 
      lang.name && lang.name.toLowerCase() === normalizedName.toLowerCase()
    )
    if (exactMatch && exactMatch.iso639_1) {
      return exactMatch.iso639_1
    }
    
    // Try to find by native name as well
    const nativeMatch = allLanguages.find(lang => 
      lang.nativeName && lang.nativeName.toLowerCase() === normalizedName.toLowerCase()
    )
    if (nativeMatch && nativeMatch.iso639_1) {
      return nativeMatch.iso639_1
    }
    
    return null
  } catch (error) {
    return null
  }
}

module.exports = {
  detectOne,
  detectMultiple,
  getLangName,
  getISO2FromName
}
