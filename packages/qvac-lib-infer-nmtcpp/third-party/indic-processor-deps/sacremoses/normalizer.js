/**
 * JavaScript port of the Moses punctuation normalizer from
 * https://github.com/moses-smt/mosesdecoder/blob/master/scripts/tokenizer/normalize-punctuation.perl
 */

class MosesPunctNormalizer {
  /**
   * Initialize a new Moses punctuation normalizer
   *
   * @param {string} lang - The two-letter language code (default: "en")
   * @param {Object} options - Configuration options
   * @param {boolean} options.penn - Normalize Penn Treebank style quotations (default: true)
   * @param {boolean} options.normQuoteCommas - Normalize quotations and commas (default: true)
   * @param {boolean} options.normNumbers - Normalize numbers (default: true)
   * @param {boolean} options.preReplaceUnicodePunct - Replace Unicode punctuation before normalization (default: false)
   * @param {boolean} options.postRemoveControlChars - Remove control characters after normalization (default: false)
   * @param {boolean} options.perlParity - Exact parity with Perl script (default: false)
   */
  constructor (lang = 'en', options = {}) {
    // Set default options
    const defaults = {
      penn: true,
      normQuoteCommas: true,
      normNumbers: true,
      preReplaceUnicodePunct: false,
      postRemoveControlChars: false,
      perlParity: false
    }

    // Merge provided options with defaults
    const opts = { ...defaults, ...options }

    // Extract options into variables for clarity
    const {
      penn,
      normQuoteCommas,
      normNumbers,
      preReplaceUnicodePunct,
      postRemoveControlChars,
      perlParity
    } = opts

    // Define regex substitution patterns

    // Extra whitespace patterns (lines 21-30)
    this.EXTRA_WHITESPACE = [
      [/\r/g, ''],
      [/\(/g, ' ('],
      [/\)/g, ') '],
      [/ +/g, ' '],
      [/\) ([.!:?;,])/g, ')$1'],
      [/\( /g, '('],
      [/ \)/g, ')'],
      [/(\d) %/g, '$1%'],
      [/ :/g, ':'],
      [/ ;/g, ';']
    ]

    // Normalize Unicode if not Penn (lines 33-34)
    this.NORMALIZE_UNICODE_IF_NOT_PENN = [
      [/`/g, "'"],
      [/''/g, ' " ']
    ]

    // Normalize Unicode patterns (lines 37-50)
    this.NORMALIZE_UNICODE = [
      [/„/g, '"'],
      [/"/g, '"'],
      [/"/g, '"'],
      [/–/g, '-'],
      [/—/g, ' - '],
      [/ +/g, ' '],
      [/´/g, "'"],
      [/([a-zA-Z])'([a-zA-Z])/g, "$1'$2"],
      [/([a-zA-Z])'([a-zA-Z])/g, "$1'$2"],
      [/'/g, "'"],
      [/‚/g, "'"],
      [/'/g, "'"],
      [/''/g, '"'],
      [/´´/g, '"'],
      [/…/g, '...']
    ]

    // French quotes patterns (lines 52-57)
    this.FRENCH_QUOTES = [
      [/\u00A0«\u00A0/g, '"'],
      [/«\u00A0/g, '"'],
      [/«/g, '"'],
      [/\u00A0»\u00A0/g, '"'],
      [/\u00A0»/g, '"'],
      [/»/g, '"']
    ]

    // Handle pseudo spaces patterns (lines 59-67)
    this.HANDLE_PSEUDO_SPACES = [
      [/\u00A0%/g, '%'],
      [/nº\u00A0/g, 'nº '],
      [/\u00A0:/g, ':'],
      [/\u00A0ºC/g, ' ºC'],
      [/\u00A0cm/g, ' cm'],
      [/\u00A0\?/g, '?'],
      [/\u00A0!/g, '!'],
      [/\u00A0;/g, ';'],
      [/,\u00A0/g, ', '],
      [/ +/g, ' ']
    ]

    // English quotation followed by comma patterns
    this.EN_QUOTATION_FOLLOWED_BY_COMMA = [[/"([,.]+)/g, '$1"']]

    // German, Spanish, French quotation followed by comma patterns
    this.DE_ES_FR_QUOTATION_FOLLOWED_BY_COMMA = [
      [/,"/g, '",'],
      [/(\.+)"(\s*[^<])/g, '"$1$2'] // don't fix period at end of sentence
    ]

    // German, Spanish, Czech, French number patterns
    this.DE_ES_CZ_CS_FR = [[/(\d)\u00A0(\d)/g, '$1,$2']]

    // Other number patterns
    this.OTHER = [[/(\d)\u00A0(\d)/g, '$1.$2']]

    // Replace Unicode punctuation patterns
    this.REPLACE_UNICODE_PUNCTUATION = [
      [/，/g, ','],
      [/。\s*/g, '. '],
      [/、/g, ','],
      [/"/g, '"'],
      [/"/g, '"'],
      [/∶/g, ':'],
      [/：/g, ':'],
      [/？/g, '?'],
      [/《/g, '"'],
      [/》/g, '"'],
      [/）/g, ')'],
      [/！/g, '!'],
      [/（/g, '('],
      [/；/g, ';'],
      [/」/g, '"'],
      [/「/g, '"'],
      [/０/g, '0'],
      [/１/g, '1'],
      [/２/g, '2'],
      [/３/g, '3'],
      [/４/g, '4'],
      [/５/g, '5'],
      [/６/g, '6'],
      [/７/g, '7'],
      [/８/g, '8'],
      [/９/g, '9'],
      [/．\s*/g, '. '],
      [/～/g, '~'],
      [/'/g, "'"],
      [/…/g, '...'],
      [/━/g, '-'],
      [/〈/g, '<'],
      [/〉/g, '>'],
      [/【/g, '['],
      [/】/g, ']'],
      [/％/g, '%']
    ]

    // Modify patterns if perl parity is requested
    if (perlParity) {
      this.NORMALIZE_UNICODE[11] = [/’/g, '"'] // Only replace curved apostrophe
      this.FRENCH_QUOTES[0] = [/\u00A0«\u00A0/g, ' "']
      this.FRENCH_QUOTES[3] = [/\u00A0»\u00A0/g, '" ']
    }

    // Build the substitutions array
    this.substitutions = []

    // Add extra whitespace patterns
    this.substitutions.push(...this.EXTRA_WHITESPACE)

    // Add Penn substitutions if requested
    if (penn) {
      this.substitutions.push(...this.NORMALIZE_UNICODE_IF_NOT_PENN)
    }

    // Add normalize unicode patterns
    this.substitutions.push(...this.NORMALIZE_UNICODE)

    // Add French quotes patterns
    this.substitutions.push(...this.FRENCH_QUOTES)

    // Add pseudo spaces patterns
    this.substitutions.push(...this.HANDLE_PSEUDO_SPACES)

    // Add quotation-comma normalization if requested
    if (normQuoteCommas) {
      if (lang === 'en') {
        this.substitutions.push(...this.EN_QUOTATION_FOLLOWED_BY_COMMA)
      } else if (['de', 'es', 'fr'].includes(lang)) {
        this.substitutions.push(...this.DE_ES_FR_QUOTATION_FOLLOWED_BY_COMMA)
      }
    }

    // Add number normalization if requested
    if (normNumbers) {
      if (['de', 'es', 'cz', 'cs', 'fr'].includes(lang)) {
        this.substitutions.push(...this.DE_ES_CZ_CS_FR)
      } else {
        this.substitutions.push(...this.OTHER)
      }
    }

    this.preReplaceUnicodePunct = preReplaceUnicodePunct
    this.postRemoveControlChars = postRemoveControlChars
  }

  /**
   * Normalize punctuation in text
   *
   * @param {string} text - The text to normalize
   * @returns {string} - The normalized text
   */
  normalize (text) {
    // Optionally, replace unicode puncts BEFORE normalization
    if (this.preReplaceUnicodePunct) {
      text = this.replaceUnicodePunct(text)
    }

    // Actual normalization
    for (const [regexp, substitution] of this.substitutions) {
      text = text.replace(regexp, substitution)
    }

    // Optionally, remove control characters AFTER normalization
    if (this.postRemoveControlChars) {
      text = this.removeControlChars(text)
    }

    return text.trim()
  }

  /**
   * Replace Unicode punctuation with ASCII equivalents
   *
   * @param {string} text - The text to process
   * @returns {string} - The processed text
   */
  replaceUnicodePunct (text) {
    for (const [regexp, substitution] of this.REPLACE_UNICODE_PUNCTUATION) {
      text = text.replace(regexp, substitution)
    }
    return text
  }

  /**
   * Remove control characters from text
   *
   * @param {string} text - The text to process
   * @returns {string} - The processed text
   */
  removeControlChars (text) {
    // JavaScript doesn't have direct equivalent to Python's regex \p{C}
    // This regex removes common control characters
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\x00-\x1F]/g, '')
  }
}

module.exports = { MosesPunctNormalizer }
