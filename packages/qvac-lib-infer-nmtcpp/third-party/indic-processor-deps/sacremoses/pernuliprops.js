/**
 * JavaScript port of the Perluniprops class from sacremoses
 * This class is used to read lists of characters from the Perl Unicode Properties
 * (see http://perldoc.perl.org/perluniprops.html).
 */

const fs = require('bare-fs')

const pernuniPropsAssets = {
  CJK: require.asset('./data/perluniprops/CJK.txt'),
  CJKSymbols: require.asset('./data/perluniprops/CJKSymbols.txt'),
  Close_Punctuation: require.asset('./data/perluniprops/Close_Punctuation.txt'),
  Currency_Symbol: require.asset('./data/perluniprops/Currency_Symbol.txt'),
  Han: require.asset('./data/perluniprops/Han.txt'),
  Hangul: require.asset('./data/perluniprops/Hangul.txt'),
  Hangul_Syllables: require.asset('./data/perluniprops/Hangul_Syllables.txt'),
  Hiragana: require.asset('./data/perluniprops/Hiragana.txt'),
  IsAlnum: require.asset('./data/perluniprops/IsAlnum.txt'),
  'IsAlnum-unichars-au': require.asset('./data/perluniprops/IsAlnum-unichars-au.txt'),
  IsAlpha: require.asset('./data/perluniprops/IsAlpha.txt'),
  'IsAlpha-unichars-au': require.asset('./data/perluniprops/IsAlpha-unichars-au.txt'),
  IsLower: require.asset('./data/perluniprops/IsLower.txt'),
  IsN: require.asset('./data/perluniprops/IsN.txt'),
  IsPf: require.asset('./data/perluniprops/IsPf.txt'),
  IsPi: require.asset('./data/perluniprops/IsPi.txt'),
  IsSc: require.asset('./data/perluniprops/IsSc.txt'),
  IsSo: require.asset('./data/perluniprops/IsSo.txt'),
  IsUpper: require.asset('./data/perluniprops/IsUpper.txt'),
  Katakana: require.asset('./data/perluniprops/Katakana.txt'),
  Line_Separator: require.asset('./data/perluniprops/Line_Separator.txt'),
  Lowercase_Letter: require.asset('./data/perluniprops/Lowercase_Letter.txt'),
  Number: require.asset('./data/perluniprops/Number.txt'),
  Open_Punctuation: require.asset('./data/perluniprops/Open_Punctuation.txt'),
  Punctuation: require.asset('./data/perluniprops/Punctuation.txt'),
  Separator: require.asset('./data/perluniprops/Separator.txt'),
  Symbol: require.asset('./data/perluniprops/Symbol.txt'),
  Titlecase_Letter: require.asset('./data/perluniprops/Titlecase_Letter.txt'),
  Uppercase_Letter: require.asset('./data/perluniprops/Uppercase_Letter.txt')
}

const nonBreakingPrefixAssets = {
  'nonbreaking_prefix.as': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.as'),
  'nonbreaking_prefix.bn': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.bn'),
  'nonbreaking_prefix.ca': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.ca'),
  'nonbreaking_prefix.cs': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.cs'),
  'nonbreaking_prefix.de': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.de'),
  'nonbreaking_prefix.el': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.el'),
  'nonbreaking_prefix.en': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.en'),
  'nonbreaking_prefix.es': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.es'),
  'nonbreaking_prefix.et': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.et'),
  'nonbreaking_prefix.fi': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.fi'),
  'nonbreaking_prefix.fr': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.fr'),
  'nonbreaking_prefix.ga': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.ga'),
  'nonbreaking_prefix.gu': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.gu'),
  'nonbreaking_prefix.hi': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.hi'),
  'nonbreaking_prefix.hu': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.hu'),
  'nonbreaking_prefix.is': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.is'),
  'nonbreaking_prefix.it': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.it'),
  'nonbreaking_prefix.kn': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.kn'),
  'nonbreaking_prefix.lt': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.lt'),
  'nonbreaking_prefix.lv': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.lv'),
  'nonbreaking_prefix.ml': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.ml'),
  'nonbreaking_prefix.mni': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.mni'),
  'nonbreaking_prefix.mr': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.mr'),
  'nonbreaking_prefix.nl': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.nl'),
  'nonbreaking_prefix.or': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.or'),
  'nonbreaking_prefix.pa': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.pa'),
  'nonbreaking_prefix.pl': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.pl'),
  'nonbreaking_prefix.pt': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.pt'),
  'nonbreaking_prefix.ro': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.ro'),
  'nonbreaking_prefix.ru': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.ru'),
  'nonbreaking_prefix.sk': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.sk'),
  'nonbreaking_prefix.sl': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.sl'),
  'nonbreaking_prefix.sv': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.sv'),
  'nonbreaking_prefix.ta': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.ta'),
  'nonbreaking_prefix.tdt': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.tdt'),
  'nonbreaking_prefix.te': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.te'),
  'nonbreaking_prefix.yue': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.yue'),
  'nonbreaking_prefix.zh': require.asset('./data/nonbreaking_prefixes/nonbreaking_prefix.zh')
}

class Perluniprops {
  /**
   * Initialize the Perluniprops class
   */
  constructor () {
    // Cache for loaded character sets
    this._cache = {}
  }

  /**
   * Load a character set from a file
   * @param {string} category - The Unicode character category to load
   * @returns {string} - A string containing all characters in the category
   * @private
   */
  _loadCategory (category) {
    const filePath = pernuniPropsAssets?.[category]

    // Check if file exists
    if (!filePath) {
      throw new Error(`Category file not found: ${category}`)
    }
    // Read the file content and decode as UTF-8
    const content = fs.readFileSync(filePath, { encoding: 'utf8' })

    // Ensure we return a string, handle potential null/undefined
    if (typeof content !== 'string') {
      return ''
    }

    return content
  }

  /**
   * Get characters from a specific Unicode category
   * @param {string} category - The Unicode character category
   * @returns {Generator} - A generator yielding characters from the category
   */
  * chars (category) {
    // Check if category is already cached
    if (!this._cache[category]) {
      try {
        const loadedData = this._loadCategory(category)
        this._cache[category] = loadedData || ''
      } catch (error) {
        console.error(`Error loading category ${category}: ${error.message}`)
        this._cache[category] = ''
      }
    }

    // Ensure the cached value is iterable
    const cachedData = this._cache[category]
    if (typeof cachedData !== 'string' && !Array.isArray(cachedData) && typeof cachedData[Symbol.iterator] !== 'function') {
      this._cache[category] = ''
      return
    }

    // Yield each character in the category
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

    // Also add the language IDs as the keys
    Object.keys(this.available_langs).forEach((key) => {
      const value = this.available_langs[key]
      this.available_langs[value] = value
    })

    // Cache for loaded prefixes
    this._cache = {}
  }

  /**
   * Load nonbreaking prefixes from a file
   * @param {string} filename - The filename to load
   * @param {string} ignoreLineStartswith - Lines to ignore in file
   * @returns {Array<string>} - An array of nonbreaking prefixes
   * @private
   */
  _loadFile (filename, ignoreLineStartswith = '#') {
    const filePath = nonBreakingPrefixAssets?.[filename]

    // Check if file exists
    if (!filePath) {
      console.warn(`Nonbreaking prefixes file not found: ${filename}`)
      return []
    }

    try {
      // Read the file content
      const content = fs.readFileSync(filePath, { encoding: 'utf8' })

      // Filter and process lines
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith(ignoreLineStartswith))
    } catch (error) {
      console.error(`Error reading file ${filePath}: ${error.message}`)
      return []
    }
  }

  /**
   * Generator function that yields nonbreaking prefixes for the specified language(s)
   * @param {string|null} lang - Language code (default: null for all languages)
   * @param {string} ignoreLineStartswith - Lines to ignore in file (default: "#")
   * @yields {string} - Nonbreaking prefixes
   */
  * words (lang = null, ignoreLineStartswith = '#') {
    // Determine which files to load based on the lang parameter
    let filenames = []

    if (lang && lang in this.available_langs) {
      // If language is available, use it
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

    // Process each file
    for (const filename of filenames) {
      // Check if already cached
      if (!this._cache[filename]) {
        this._cache[filename] = this._loadFile(filename, ignoreLineStartswith)
      }

      // Yield each prefix
      for (const prefix of this._cache[filename]) {
        yield prefix
      }
    }
  }

  /**
   * Get all nonbreaking prefixes for the specified language(s) as an array
   * @param {string|null} lang - Language code
   * @param {string} ignoreLineStartswith - Lines to ignore in file
   * @returns {Array<string>} - An array of nonbreaking prefixes
   */
  getWordsAsArray (lang = null, ignoreLineStartswith = '#') {
    return [...this.words(lang, ignoreLineStartswith)]
  }
}

// Export both implementations
module.exports = {
  Perluniprops,
  NonbreakingPrefixes
}
