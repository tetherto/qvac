'use strict'

const { detectAll, toISO3, toISO2, langName, supportedLanguages } = require('tinyld/heavy')

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

let langNameMap = null

/**
 * Detects the most probable language for a given text.
 * @param {string} text The text to analyze.
 * @returns {Object} The detected language or `Undetermined` if no language is detected.
 */
function detectOne (text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return {
      code: 'und',
      language: 'Undetermined'
    }
  }

  const results = detectAll(text)
  if (results.length === 0) {
    return {
      code: 'und',
      language: 'Undetermined'
    }
  }

  const code = results[0].lang
  return {
    code,
    language: langName(toISO3(code))
  }
}

/**
 * Detect multiple probable languages for a given text.
 * @param {string} text The text to analyze.
 * @param {number} topK Number of top probable languages to return.
 * @returns {Array} A list of probable languages with probabilities.
 */
function detectMultiple (text, topK = 3) {
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

  const results = detectAll(text)
  if (results.length === 0) {
    return [{
      code: 'und',
      language: 'Undetermined',
      probability: 1
    }]
  }
  return results.slice(0, topK).map(({ lang, accuracy }) => {
    const code = lang
    return { code, language: langName(toISO3(code)), probability: accuracy }
  })
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

  try {
    let result = ''

    if (normalizedCode.length === 2) {
      const iso3 = toISO3(normalizedCode)
      if (iso3) {
        result = langName(iso3)
      }
    } else if (normalizedCode.length === 3) {
      result = langName(normalizedCode)
    }

    return (result && result.trim().length > 0) ? result : null
  } catch (error) {
    return null
  }
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

  if (langNameMap === null) {
    langNameMap = {}
    supportedLanguages.forEach(iso3 => {
      const name = langName(iso3).toLowerCase()
      const iso2 = toISO2(iso3)
      langNameMap[name] = { iso2, iso3 }
    })
  }

  const normalizedName = languageName.trim().toLowerCase()
  const langInfo = langNameMap[normalizedName]

  return langInfo ? langInfo.iso2 : null
}

module.exports = {
  detectOne,
  detectMultiple,
  getLangName,
  getISO2FromName
}
