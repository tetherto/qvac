const {
  MosesDetokenizer,
  MosesPunctNormalizer,
  MosesTokenizer
} = require('./indic-processor-deps/sacremoses')

const {
  UnicodeIndicTransliterator,
  IndicNormalizerFactory,
  IndicTokenize,
  IndicDetokenize
} = require('./indic-processor-deps/indicnlp')

/**
 * JavaScript version of the IndicProcessor class
 * Handles preprocessing and postprocessing of Indic language text
 */
class IndicProcessor {
  /**
   * Constructor for IndicProcessor. Initializes all necessary components.
   * @param {boolean} inference - Whether to use inference mode (default: true)
   */
  constructor (inference = true) {
    this.inference = inference

    /// ///////////////////////////
    // FLORES -> ISO CODES
    /// ///////////////////////////
    this._floresCodes = {
      asm_Beng: 'as',
      awa_Deva: 'hi',
      ben_Beng: 'bn',
      bho_Deva: 'hi',
      brx_Deva: 'hi',
      doi_Deva: 'hi',
      eng_Latn: 'en',
      gom_Deva: 'kK',
      gon_Deva: 'hi',
      guj_Gujr: 'gu',
      hin_Deva: 'hi',
      hne_Deva: 'hi',
      kan_Knda: 'kn',
      kas_Arab: 'ur',
      kas_Deva: 'hi',
      kha_Latn: 'en',
      lus_Latn: 'en',
      mag_Deva: 'hi',
      mai_Deva: 'hi',
      mal_Mlym: 'ml',
      mar_Deva: 'mr',
      mni_Beng: 'bn',
      mni_Mtei: 'hi',
      npi_Deva: 'ne',
      ory_Orya: 'or',
      pan_Guru: 'pa',
      san_Deva: 'hi',
      sat_Olck: 'or',
      snd_Arab: 'ur',
      snd_Deva: 'hi',
      tam_Taml: 'ta',
      tel_Telu: 'te',
      urd_Arab: 'ur',
      unr_Deva: 'hi'
    }

    /// ///////////////////////////
    // INDIC DIGIT TRANSLATION
    /// ///////////////////////////
    this._digitsTranslationMap = new Map()
    const digitsDict = {
      '\u09e6': '0',
      '\u0ae6': '0',
      '\u0ce6': '0',
      '\u0966': '0',
      '\u0660': '0',
      '\uabf0': '0',
      '\u0b66': '0',
      '\u0a66': '0',
      '\u1c50': '0',
      '\u06f0': '0',

      '\u09e7': '1',
      '\u0ae7': '1',
      '\u0967': '1',
      '\u0ce7': '1',
      '\u06f1': '1',
      '\uabf1': '1',
      '\u0b67': '1',
      '\u0a67': '1',
      '\u1c51': '1',
      '\u0c67': '1',

      '\u09e8': '2',
      '\u0ae8': '2',
      '\u0968': '2',
      '\u0ce8': '2',
      '\u06f2': '2',
      '\uabf2': '2',
      '\u0b68': '2',
      '\u0a68': '2',
      '\u1c52': '2',
      '\u0c68': '2',

      '\u09e9': '3',
      '\u0ae9': '3',
      '\u0969': '3',
      '\u0ce9': '3',
      '\u06f3': '3',
      '\uabf3': '3',
      '\u0b69': '3',
      '\u0a69': '3',
      '\u1c53': '3',
      '\u0c69': '3',

      '\u09ea': '4',
      '\u0aea': '4',
      '\u096a': '4',
      '\u0cea': '4',
      '\u06f4': '4',
      '\uabf4': '4',
      '\u0b6a': '4',
      '\u0a6a': '4',
      '\u1c54': '4',
      '\u0c6a': '4',

      '\u09eb': '5',
      '\u0aeb': '5',
      '\u096b': '5',
      '\u0ceb': '5',
      '\u06f5': '5',
      '\uabf5': '5',
      '\u0b6b': '5',
      '\u0a6b': '5',
      '\u1c55': '5',
      '\u0c6b': '5',

      '\u09ec': '6',
      '\u0aec': '6',
      '\u096c': '6',
      '\u0cec': '6',
      '\u06f6': '6',
      '\uabf6': '6',
      '\u0b6c': '6',
      '\u0a6c': '6',
      '\u1c56': '6',
      '\u0c6c': '6',

      '\u09ed': '7',
      '\u0aed': '7',
      '\u096d': '7',
      '\u0ced': '7',
      '\u06f7': '7',
      '\uabf7': '7',
      '\u0b6d': '7',
      '\u0a6d': '7',
      '\u1c57': '7',
      '\u0c6d': '7',

      '\u09ee': '8',
      '\u0aee': '8',
      '\u096e': '8',
      '\u0cee': '8',
      '\u06f8': '8',
      '\uabf8': '8',
      '\u0b6e': '8',
      '\u0a6e': '8',
      '\u1c58': '8',
      '\u0c6e': '8',

      '\u09ef': '9',
      '\u0aef': '9',
      '\u096f': '9',
      '\u0cef': '9',
      '\u06f9': '9',
      '\uabf9': '9',
      '\u0b6f': '9',
      '\u0a6f': '9',
      '\u1c59': '9',
      '\u0c6f': '9'
    }

    for (const [k, v] of Object.entries(digitsDict)) {
      this._digitsTranslationMap.set(k, v)
    }

    // Also map ASCII '0'-'9'
    for (let c = '0'.charCodeAt(0); c <= '9'.charCodeAt(0); c++) {
      this._digitsTranslationMap.set(
        String.fromCharCode(c),
        String.fromCharCode(c)
      )
    }

    /// ///////////////////////////
    // PLACEHOLDER MAP QUEUE
    /// ///////////////////////////
    this._placeholderEntityMaps = []

    /// ///////////////////////////
    // Dependency Imports
    // Note: In a real implementation, these would be imported from their respective modules
    /// ///////////////////////////
    this._enTok = new MosesTokenizer('en')
    this._enNormalizer = new MosesPunctNormalizer('en')
    this._enDetok = new MosesDetokenizer('en')
    this._xliterator = UnicodeIndicTransliterator

    // These would normally be imported from indicnlp
    this._indicTokenize = IndicTokenize
    this._indicDetokenize = IndicDetokenize
    this._indicNormalizerFactory = IndicNormalizerFactory

    /// ///////////////////////////
    // Precompiled Patterns
    /// ///////////////////////////
    this._MULTISPACE_REGEX = /[ ]{2,}/g
    this._DIGIT_SPACE_PERCENT = /(\d) %/g
    this._DOUBLE_QUOT_PUNC = /"([,.]+)/g
    this._DIGIT_NBSP_DIGIT = /(\d) (\d)/g
    this._END_BRACKET_SPACE_PUNC_REGEX = /\) ([.!:?;,])/g

    this._URL_PATTERN =
      /\b(?<![\w/.])(?:(?:https?|ftp):\/\/)?(?:(?:[\w-]+\.)+(?!\.))(?:[\w/\-?#&=%.]+)+(?!\.\w+)\b/g
    this._NUMERAL_PATTERN =
      /(~?\d+\.?\d*\s?%?\s?-?\s?~?\d+\.?\d*\s?%|~?\d+%|\d+[-/.,:']\d+[-/.,:'+]\d+(?:\.\d+)?|\d+[-/.:'+]\d+(?:\.\d+)?)/g
    this._EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}/g
    this._OTHER_PATTERN = /[A-Za-z0-9]*[#|@]\w+/g

    // Combined punctuation replacements
    this._PUNC_REPLACEMENTS = [
      [/\r/g, ''],
      [/\(\s*/g, '('],
      [/\s*\)/g, ')'],
      [/\s:\s?/g, ':'],
      [/\s;\s?/g, ';'],
      [/[`´'‚']/g, "'"],
      [/[„""«»]/g, '"'],
      [/[–—]/g, '-'],
      [/\.\.\./g, '...'],
      [/ %/g, '%'],
      [/nº /g, 'nº '],
      [/ ºC/g, ' ºC'],
      [/ [?!;]/g, (m) => m[0].trim()],
      [/, /g, ', ']
    ]

    this._INDIC_FAILURE_CASES = [
      'آی ڈی ',
      'ꯑꯥꯏꯗꯤ',
      'आईडी',
      'आई . डी . ',
      'आई . डी .',
      'आई. डी. ',
      'आई. डी.',
      'आय. डी. ',
      'आय. डी.',
      'आय . डी . ',
      'आय . डी .',
      'ऐटि',
      'آئی ڈی ',
      'ᱟᱭᱰᱤ ᱾',
      'आयडी',
      'ऐडि',
      'आइडि',
      'ᱟᱭᱰᱤ'
    ]
  }

  /**
   * Apply punctuation replacements to text
   * @private
   * @param {string} text - Text to process
   * @param {Array} replacements - Array of [pattern, replacement] pairs
   * @returns {string} - Processed text
   */
  _applyPuncReplacements (text, replacements) {
    for (const [pattern, replacement] of replacements) {
      text = text.replace(pattern, replacement)
    }
    return text
  }

  /**
   * Normalize punctuation in text
   * @private
   * @param {string} text - Text to normalize
   * @returns {string} - Normalized text
   */
  _puncNorm (text) {
    // 1) Apply replacements
    text = this._applyPuncReplacements(text, this._PUNC_REPLACEMENTS)

    // 2) Additional patterns
    text = text.replace(this._MULTISPACE_REGEX, ' ')
    text = text.replace(this._END_BRACKET_SPACE_PUNC_REGEX, ')$1')
    text = text.replace(this._DIGIT_SPACE_PERCENT, '$1%')
    text = text.replace(this._DOUBLE_QUOT_PUNC, '$1"')
    text = text.replace(this._DIGIT_NBSP_DIGIT, '$1.$2')
    return text.trim()
  }

  /**
   * Wrap substrings with matched patterns in the text with placeholders
   * @private
   * @param {string} text - Text to process
   * @returns {string} - Text with placeholders
   */
  _wrapWithPlaceholders (text) {
    let serialNo = 1
    const placeholderEntityMap = {}
    const patterns = [
      this._EMAIL_PATTERN,
      this._URL_PATTERN,
      this._NUMERAL_PATTERN,
      this._OTHER_PATTERN
    ]

    for (const pattern of patterns) {
      // Reset lastIndex to ensure we find all matches
      pattern.lastIndex = 0

      // Find all matches of this pattern
      const matches = new Set()
      let match
      while ((match = pattern.exec(text)) !== null) {
        matches.add(match[0])
      }

      for (const match of matches) {
        // Additional checks
        if (pattern === this._URL_PATTERN) {
          if (match.replace(/\./g, '').length < 4) {
            continue
          }
        }
        if (pattern === this._NUMERAL_PATTERN) {
          if (
            match.replace(/\s/g, '').replace(/\./g, '').replace(/:/g, '')
              .length < 4
          ) {
            continue
          }
        }

        const basePlaceholder = `<ID${serialNo}>`
        // Map various placeholder formats to the matched text
        placeholderEntityMap[`<ID${serialNo}>`] = match
        placeholderEntityMap[`< ID${serialNo} >`] = match
        placeholderEntityMap[`[ID${serialNo}]`] = match
        placeholderEntityMap[`[ ID${serialNo} ]`] = match
        placeholderEntityMap[`[ID ${serialNo}]`] = match
        placeholderEntityMap[`<ID${serialNo}]`] = match
        placeholderEntityMap[`< ID${serialNo}]`] = match
        placeholderEntityMap[`<ID${serialNo} ]`] = match

        // Handle Indic failure cases
        for (const indicCase of this._INDIC_FAILURE_CASES) {
          placeholderEntityMap[`<${indicCase}${serialNo}>`] = match
          placeholderEntityMap[`< ${indicCase}${serialNo} >`] = match
          placeholderEntityMap[`< ${indicCase} ${serialNo} >`] = match
          placeholderEntityMap[`<${indicCase} ${serialNo}]`] = match
          placeholderEntityMap[`< ${indicCase} ${serialNo} ]`] = match
          placeholderEntityMap[`[${indicCase}${serialNo}]`] = match
          placeholderEntityMap[`[${indicCase} ${serialNo}]`] = match
          placeholderEntityMap[`[ ${indicCase}${serialNo} ]`] = match
          placeholderEntityMap[`[ ${indicCase} ${serialNo} ]`] = match
          placeholderEntityMap[`${indicCase} ${serialNo}`] = match
          placeholderEntityMap[`${indicCase}${serialNo}`] = match
        }

        // Replace the match with the base placeholder
        text = text.replace(match, basePlaceholder)
        serialNo += 1
      }
    }

    // Clean up any remaining placeholder artifacts
    text = text.replace(/\s+/g, ' ').replace('>/', '>').replace(']/', ']')
    this._placeholderEntityMaps.push(placeholderEntityMap)
    return text
  }

  /**
   * Normalize text by translating numerals and optionally wrapping placeholders
   * @private
   * @param {string} text - Text to normalize
   * @returns {string} - Normalized text
   */
  _normalize (text) {
    // Translate digits to Latin numerals
    let normalizedText = ''
    for (const char of text) {
      normalizedText += this._digitsTranslationMap.get(char) || char
    }

    if (this.inference) {
      normalizedText = this._wrapWithPlaceholders(normalizedText)
    }
    return normalizedText
  }

  /**
   * Helper method: normalizes, tokenizes, optionally transliterates from iso_lang -> 'hi'
   * @private
   * @param {string} sentence - Input sentence
   * @param {Object} normalizer - Language normalizer
   * @param {string} isoLang - ISO language code
   * @param {boolean} transliterate - Whether to transliterate
   * @returns {string} - Processed text
   */
  _doIndicTokenizeAndTransliterate (
    sentence,
    normalizer,
    isoLang,
    transliterate
  ) {
    const normed = normalizer.normalize(sentence.trim())
    const tokens = this._indicTokenize.trivialTokenize(normed, isoLang)
    const joined = tokens.join(' ')

    if (!transliterate) {
      return joined
    }

    const xlated = this._xliterator.transliterate(joined, isoLang, 'hi')
    return xlated.replace(' ् ', '्')
  }

  /**
   * Preprocess a single sentence
   * @private
   * @param {string} sent - Input sentence
   * @param {string} srcLang - Source language code
   * @param {string} tgtLang - Target language code
   * @param {Object} normalizer - Language normalizer
   * @param {boolean} isTarget - Whether this is a target sentence
   * @returns {string} - Preprocessed sentence
   */
  _preprocess (sent, srcLang, tgtLang, normalizer, isTarget) {
    const isoLang = this._floresCodes[srcLang] || 'hi'
    const scriptPart = srcLang.split('_')[1]
    let doTransliterate = true

    // 1) Punctuation normalization
    sent = this._puncNorm(sent)

    // 2) Numerals & placeholders
    sent = this._normalize(sent)

    if (['Arab', 'Aran', 'Olck', 'Mtei', 'Latn'].includes(scriptPart)) {
      doTransliterate = false
    }

    let processedSent
    if (isoLang === 'en') {
      // English path
      const eStrip = sent.trim()
      const eNorm = this._enNormalizer.normalize(eStrip)
      const eTokens = this._enTok.tokenize(eNorm, false, false, false)
      processedSent = eTokens.join(' ')
    } else {
      // Indic path
      processedSent = this._doIndicTokenizeAndTransliterate(
        sent,
        normalizer,
        isoLang,
        doTransliterate
      )
    }

    processedSent = processedSent.trim()
    if (!isTarget) {
      return `${srcLang} ${tgtLang} ${processedSent}`
    } else {
      return processedSent
    }
  }

  /**
   * Postprocess a single sentence
   * @private
   * @param {string|Array} sent - Input sentence or array with sentence
   * @param {string} lang - Language code
   * @returns {string} - Postprocessed sentence
   */
  _postprocess (sent, lang) {
    // Unwrap if sent is a tuple or list
    if (Array.isArray(sent)) {
      sent = sent[0]
    }

    const placeholderEntityMap = this._placeholderEntityMaps.length ? this._placeholderEntityMaps[0] : undefined
    const [langCode, scriptCode] = lang.split('_', 2)
    const isoLang = this._floresCodes[lang] || 'hi'

    // Fix for Perso-Arabic scripts
    if (['Arab', 'Aran'].includes(scriptCode)) {
      sent = sent
        .replace(' ؟', '؟')
        .replace(' ۔', '۔')
        .replace(' ،', '،')
        .replace('ٮ۪', 'ؠ')
    }

    // Oriya fix
    if (langCode === 'ory') {
      sent = sent.replace('ଯ଼', 'ୟ')
    }

    // Restore placeholders
    if (placeholderEntityMap) {
      for (const [k, v] of Object.entries(placeholderEntityMap)) {
        sent = sent.replace(k, v)
      }
    }

    // Detokenize
    if (lang === 'eng_Latn') {
      return this._enDetok.detokenize(sent.split(' '))
    } else {
      const xlated = this._xliterator.transliterate(sent, 'hi', isoLang)
      return this._indicDetokenize.trivialDetokenize(xlated, isoLang)
    }
  }

  /**
   * Preprocess a batch of sentences (normalize, tokenize, transliterate)
   * @public
   * @param {Array<string>} batch - Array of sentences
   * @param {string} srcLang - Source language code
   * @param {string} tgtLang - Target language code (optional)
   * @param {boolean} isTarget - Whether these are target sentences
   * @returns {Array<string>} - Preprocessed sentences
   */
  preprocessBatch (
    batch,
    srcLang,
    tgtLang = 'hin_Deva',
    isTarget = false
  ) {
    let normalizer = null
    const isoCode = this._floresCodes[srcLang] || 'hi'

    if (srcLang !== 'eng_Latn') {
      normalizer = this._indicNormalizerFactory.getNormalizer(isoCode)
    }

    return batch.map((s) =>
      this._preprocess(s, srcLang, tgtLang, normalizer, isTarget)
    )
  }

  /**
   * Postprocess a batch of sentences
   * @public
   * @param {Array<string>} sents - Array of sentences
   * @param {string} lang - Language code
   * @returns {Array<string>} - Postprocessed sentences
   */
  postprocessBatch (sents, lang = 'hin_Deva') {
    return sents.map((s) => this._postprocess(s, lang))
  }
}

module.exports = { IndicProcessor }
