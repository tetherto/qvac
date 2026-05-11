/**
 * JavaScript port of the Perluniprops class from sacremoses.
 *
 * This class is used to read lists of characters from the Perl
 * Unicode Properties (see http://perldoc.perl.org/perluniprops.html)
 * and the Moses tokenizer's per-language nonbreaking-prefix files.
 *
 * Loading model: data lives in `./data.js` as a plain JS module.
 * Previously each .txt file was loaded at runtime via
 * `require.asset() + bare-fs.readFileSync()`, which works on desktop
 * (where the .txt files sit on disk next to the code) but fails on
 * mobile — `bare-pack --linked` resolves the asset paths but does
 * NOT embed the file contents into the worker.bundle's virtual
 * filesystem, so `readFileSync` throws ENOENT and downstream Moses
 * tokenization silently degrades to empty Unicode tables. That
 * was the QVAC-16488 mobile IndicTrans regression.
 *
 * Switching to a plain `require('./data.js')` puts both platforms on
 * the most fundamental Bare module-resolution path, which works in
 * every bundler mode.
 */

const { perluniprops, nonbreakingPrefixes } = require('./data.js')

class Perluniprops {
  /**
   * Initialize the Perluniprops class
   */
  constructor () {
    // Per-instance cache for already-iterated character sets.
    // Even though the underlying data is shared, the cache keeps
    // the public `chars()` generator API backwards-compatible with
    // the previous implementation (callers may rely on category
    // strings being consistent between calls).
    this._cache = {}
  }

  /**
   * Look up the raw character string for a Unicode category.
   * Returns '' if the category is unknown — matches the previous
   * behaviour of catching ENOENT and falling back to empty (now
   * "missing" can only mean "category name typo", since data is
   * statically bundled).
   *
   * @param {string} category - The Unicode character category to load
   * @returns {string} - A string containing all characters in the category
   * @private
   */
  _loadCategory (category) {
    return perluniprops[category] || ''
  }

  /**
   * Get characters from a specific Unicode category
   * @param {string} category - The Unicode character category
   * @returns {Generator} - A generator yielding characters from the category
   */
  * chars (category) {
    if (!this._cache[category]) {
      this._cache[category] = this._loadCategory(category) || ''
    }

    // Defensive: ensure cached value is iterable (matches previous
    // implementation; preserved so any caller writing through the
    // cache cannot break iteration).
    const cachedData = this._cache[category]
    if (typeof cachedData !== 'string' && !Array.isArray(cachedData) && typeof cachedData[Symbol.iterator] !== 'function') {
      this._cache[category] = ''
      return
    }

    for (const char of this._cache[category]) {
      yield char
    }
  }
}

class NonbreakingPrefixes {
  /**
   * Initialize a new NonbreakingPrefixes instance
   */
  constructor () {
    // Map of language names to language codes
    this.available_langs = {
      assamese: 'as',
      bengali: 'bn',
      catalan: 'ca',
      czech: 'cs',
      german: 'de',
      greek: 'el',
      english: 'en',
      spanish: 'es',
      estonian: 'et',
      finnish: 'fi',
      french: 'fr',
      irish: 'ga',
      gujarati: 'gu',
      hindi: 'hi',
      hungarian: 'hu',
      icelandic: 'is',
      italian: 'it',
      kannada: 'kn',
      lithuanian: 'lt',
      latvian: 'lv',
      malayalam: 'ml',
      manipuri: 'mni',
      marathi: 'mr',
      dutch: 'nl',
      oriya: 'or',
      punjabi: 'pa',
      polish: 'pl',
      portuguese: 'pt',
      romanian: 'ro',
      russian: 'ru',
      slovak: 'sk',
      slovenian: 'sl',
      swedish: 'sv',
      tamil: 'ta',
      telugu: 'te',
      tetum: 'tdt',
      cantonese: 'yue',
      chinese: 'zh'
    }

    // Also add the language codes themselves as keys (so callers can
    // pass either "english" or "en").
    Object.keys(this.available_langs).forEach((key) => {
      const value = this.available_langs[key]
      this.available_langs[value] = value
    })

    // Per-instance cache for already-loaded prefix lists.
    this._cache = {}
  }

  /**
   * Look up the prefix array for a specific filename. Returns []
   * if the filename is unknown.
   *
   * The `ignoreLineStartswith` parameter from the previous
   * filesystem-based implementation is intentionally dropped —
   * filtering happens once in scripts/generate-sacremoses-data.js
   * (defaulted to '#'), which is the only filter ever used by
   * tokenizer.js callers. If a future caller really needs a
   * different ignore prefix at runtime, it can post-filter the
   * result of getWordsAsArray().
   *
   * @param {string} filename - e.g. "nonbreaking_prefix.en"
   * @returns {Array<string>} - filtered nonbreaking prefixes
   * @private
   */
  _loadFile (filename) {
    return nonbreakingPrefixes[filename] || []
  }

  /**
   * Generator function that yields nonbreaking prefixes for the specified language(s)
   * @param {string|null} lang - Language code (default: null for all languages)
   * @yields {string} - Nonbreaking prefixes
   */
  * words (lang = null) {
    let filenames = []

    if (lang && lang in this.available_langs) {
      filenames = [`nonbreaking_prefix.${this.available_langs[lang]}`]
    } else if (lang === null) {
      // Use all languages when lang is null
      const uniqueLangCodes = new Set(Object.values(this.available_langs))
      filenames = Array.from(uniqueLangCodes).map(
        (code) => `nonbreaking_prefix.${code}`
      )
    } else {
      // Default to English if language not available
      filenames = ['nonbreaking_prefix.en']
    }

    for (const filename of filenames) {
      if (!this._cache[filename]) {
        this._cache[filename] = this._loadFile(filename)
      }
      for (const prefix of this._cache[filename]) {
        yield prefix
      }
    }
  }

  /**
   * Get all nonbreaking prefixes for the specified language(s) as an array
   * @param {string|null} lang - Language code
   * @returns {Array<string>} - An array of nonbreaking prefixes
   */
  getWordsAsArray (lang = null) {
    return [...this.words(lang)]
  }
}

module.exports = {
  Perluniprops,
  NonbreakingPrefixes
}
