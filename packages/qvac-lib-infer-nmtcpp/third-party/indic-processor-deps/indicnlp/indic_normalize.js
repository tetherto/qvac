/**
 *
 *  Copyright (c) 2013-present, Anoop Kunchukuttan
 *  All rights reserved.
 *
 *  This source code is licensed under the MIT license found in the
 *  INDIC_NPL_LICENCE file in the indicnlp directory of this source tree.
 *
 *  This code is a ported version of the sacremoses library. Please refer to NOTICE
 *  file in the root directory of this source tree.
 */

const langinfo = require('./langinfo')

class NormalizerI {
  /**
   * The normalizer classes do the following:
   * * Some characters have multiple Unicode codepoints. The normalizer chooses a single standard representation
   * * Some control characters are deleted
   * * While typing using the Latin keyboard, certain typical mistakes occur which are corrected by the module
   * Base class for normalizer. Performs some common normalization, which includes:
   * * Byte order mark, word joiner, etc. removal
   * * ZERO_WIDTH_NON_JOINER and ZERO_WIDTH_JOINER removal
   * * ZERO_WIDTH_SPACE and NO_BREAK_SPACE replaced by spaces
   * Script specific normalizers should derive from this class and override the normalize() method.
   * They can call the super class 'normalize() method to avail of the common normalization
   */

  static BYTE_ORDER_MARK = '\uFEFF'
  static BYTE_ORDER_MARK_2 = '\uFFFE'
  static WORD_JOINER = '\u2060'
  static SOFT_HYPHEN = '\u00AD'

  static ZERO_WIDTH_SPACE = '\u200B'
  static NO_BREAK_SPACE = '\u00A0'

  static ZERO_WIDTH_NON_JOINER = '\u200C'
  static ZERO_WIDTH_JOINER = '\u200D'

  _normalizePunctuations (text) {
    /**
     * Normalize punctuations.
     * Applied many of the punctuation normalizations that are part of MosesNormalizer
     * from sacremoses
     */
    text = text.replace(NormalizerI.BYTE_ORDER_MARK, '')
    text = text.replace(/„/g, '"')
    text = text.replace(/"/g, '"')
    text = text.replace(/"/g, '"')
    text = text.replace(/–/g, '-')
    text = text.replace(/—/g, ' - ')
    text = text.replace(/´/g, "'")
    text = text.replace(/'/g, "'")
    text = text.replace(/‚/g, "'")
    text = text.replace(/'/g, "'")
    text = text.replace(/''/g, '"')
    text = text.replace(/´´/g, '"')
    text = text.replace(/…/g, '...')

    return text
  }

  normalize (text) {
    // Method to be implemented by subclasses
  }
}

class BaseNormalizer extends NormalizerI {
  /**
   * Base normalizer for Indic scripts
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   * @param {string} nasalsMode - How to handle nasal characters ('do_nothing', 'to_anusvaara_strict', 'to_anusvaara_relaxed', 'to_nasal_consonants')
   * @param {boolean} doNormalizeChandras - Whether to normalize chandra characters
   * @param {boolean} doNormalizeVowelEnding - Whether to normalize vowel endings
   */
  constructor (
    lang = 'hi',
    removeNuktas = false,
    nasalsMode = 'do_nothing',
    doNormalizeChandras = false,
    doNormalizeVowelEnding = false
  ) {
    super()
    this.lang = lang
    this.removeNuktas = removeNuktas
    this.nasalsMode = nasalsMode
    this.doNormalizeChandras = doNormalizeChandras
    this.doNormalizeVowelEnding = doNormalizeVowelEnding

    this._initNormalizeChandras()
    this._initNormalizeNasals()
    this._initNormalizeVowelEnding()
  }

  _initNormalizeVowelEnding () {
    if (langinfo.IE_LANGUAGES.includes(this.lang)) {
      this.fnVowelEnding = this._normalizeWordVowelEndingIe
    } else if (langinfo.DRAVIDIAN_LANGUAGES.includes(this.lang)) {
      this.fnVowelEnding = this._normalizeWordVowelEndingDravidian
    } else {
      this.fnVowelEnding = (x) => x
    }
  }

  _initNormalizeChandras () {
    const substitutionOffsets = [
      [0x0d, 0x0f], // chandra e, independent
      [0x11, 0x13], // chandra o, independent
      [0x45, 0x47], // chandra e, dependent
      [0x49, 0x4b], // chandra o, dependent
      // [0x72, 0x0f], // mr: chandra e, independent

      [0x00, 0x02], // chandrabindu
      [0x01, 0x02] // chandrabindu
    ]

    this.chandraSubstitutions = substitutionOffsets.map((x) => [
      langinfo.offsetToChar(x[0], this.lang),
      langinfo.offsetToChar(x[1], this.lang)
    ])
  }

  _normalizeChandras (text) {
    for (const [match, repl] of this.chandraSubstitutions) {
      text = text.replace(new RegExp(match, 'g'), repl)
    }
    return text
  }

  _initToAnusvaaraStrict () {
    const patSignatures = [
      [0x19, 0x15, 0x18],
      [0x1e, 0x1a, 0x1d],
      [0x23, 0x1f, 0x22],
      [0x28, 0x24, 0x27],
      [0x29, 0x24, 0x27],
      [0x2e, 0x2a, 0x2d]
    ]

    const halantOffset = 0x4d
    const anusvaraOffset = 0x02

    const pats = []

    for (const patSignature of patSignatures) {
      const pat = new RegExp(
        `${langinfo.offsetToChar(
          patSignature[0],
          this.lang
        )}${langinfo.offsetToChar(
          halantOffset,
          this.lang
        )}([${langinfo.offsetToChar(
          patSignature[1],
          this.lang
        )}-${langinfo.offsetToChar(patSignature[2], this.lang)}])`,
        'g'
      )
      pats.push(pat)
    }

    const replString = `${langinfo.offsetToChar(anusvaraOffset, this.lang)}$1`

    this.patsRepls = [pats, replString]
  }

  _toAnusvaaraStrict (text) {
    const [pats, replString] = this.patsRepls
    for (const pat of pats) {
      text = text.replace(pat, replString)
    }
    return text
  }

  _initToAnusvaaraRelaxed () {
    const nasalsList = [0x19, 0x1e, 0x23, 0x28, 0x29, 0x2e]
    const nasalsListStr = nasalsList
      .map((x) => langinfo.offsetToChar(x, this.lang))
      .join('')

    const halantOffset = 0x4d
    const anusvaraOffset = 0x02

    const pat = new RegExp(
      `[${nasalsListStr}]${langinfo.offsetToChar(halantOffset, this.lang)}`,
      'g'
    )
    const replString = langinfo.offsetToChar(anusvaraOffset, this.lang)

    this.patsRepls = [pat, replString]
  }

  _toAnusvaaraRelaxed (text) {
    const [pat, replString] = this.patsRepls
    return text.replace(pat, replString)
  }

  _initToNasalConsonants () {
    const patSignatures = [
      [0x19, 0x15, 0x18],
      [0x1e, 0x1a, 0x1d],
      [0x23, 0x1f, 0x22],
      [0x28, 0x24, 0x27],
      [0x29, 0x24, 0x27],
      [0x2e, 0x2a, 0x2d]
    ]

    const halantOffset = 0x4d
    const anusvaraOffset = 0x02

    const pats = []
    const replStrings = []

    for (const patSignature of patSignatures) {
      const pat = new RegExp(
        `${langinfo.offsetToChar(
          anusvaraOffset,
          this.lang
        )}([${langinfo.offsetToChar(
          patSignature[1],
          this.lang
        )}-${langinfo.offsetToChar(patSignature[2], this.lang)}])`,
        'g'
      )
      pats.push(pat)

      const replString = `${langinfo.offsetToChar(
        patSignature[0],
        this.lang
      )}${langinfo.offsetToChar(halantOffset, this.lang)}$1`
      replStrings.push(replString)
    }

    this.patsRepls = pats.map((pat, i) => [pat, replStrings[i]])
  }

  _toNasalConsonants (text) {
    for (const [pat, repl] of this.patsRepls) {
      text = text.replace(pat, repl)
    }
    return text
  }

  _initNormalizeNasals () {
    if (this.nasalsMode === 'to_anusvaara_strict') {
      this._initToAnusvaaraStrict()
    } else if (this.nasalsMode === 'to_anusvaara_relaxed') {
      this._initToAnusvaaraRelaxed()
    } else if (this.nasalsMode === 'to_nasal_consonants') {
      this._initToNasalConsonants()
    }
  }

  _normalizeNasals (text) {
    if (this.nasalsMode === 'to_anusvaara_strict') {
      return this._toAnusvaaraStrict(text)
    } else if (this.nasalsMode === 'to_anusvaara_relaxed') {
      return this._toAnusvaaraRelaxed(text)
    } else if (this.nasalsMode === 'to_nasal_consonants') {
      return this._toNasalConsonants(text)
    } else {
      return text
    }
  }

  _normalizeWordVowelEndingDravidian (word) {
    /**
     * For Dravidian
     * - consonant ending: add 'a' ki maatra
     * - halant ending: no change
     * - 'a' ki maatra: no change
     */
    if (
      word.length > 0 &&
      langinfo.isConsonant(word.charAt(word.length - 1), this.lang)
    ) {
      return word + langinfo.offsetToChar(0x3e, this.lang)
    } else {
      return word
    }
  }

  _normalizeWordVowelEndingIe (word) {
    /**
     * For IE
     * - consonant ending: add halant
     * - halant ending: no change
     * - 'a' ki maatra: no change
     */
    if (
      word.length > 0 &&
      langinfo.isConsonant(word.charAt(word.length - 1), this.lang)
    ) {
      return word + langinfo.offsetToChar(langinfo.HALANTA_OFFSET, this.lang)
    } else {
      return word
    }
  }

  _normalizeVowelEnding (text) {
    return text
      .split(' ')
      .map((w) => this.fnVowelEnding(w))
      .join(' ')
  }

  normalize (text) {
    /**
     * Method to be implemented for normalization for each script
     */
    text = text.replace(NormalizerI.BYTE_ORDER_MARK, '')
    text = text.replace(NormalizerI.BYTE_ORDER_MARK_2, '')
    text = text.replace(NormalizerI.WORD_JOINER, '')
    text = text.replace(NormalizerI.SOFT_HYPHEN, '')

    text = text.replace(NormalizerI.ZERO_WIDTH_SPACE, ' ') // ??
    text = text.replace(NormalizerI.NO_BREAK_SPACE, ' ')

    text = text.replace(NormalizerI.ZERO_WIDTH_NON_JOINER, '')
    text = text.replace(NormalizerI.ZERO_WIDTH_JOINER, '')

    text = this._normalizePunctuations(text)

    if (this.doNormalizeChandras) {
      text = this._normalizeChandras(text)
    }
    text = this._normalizeNasals(text)
    if (this.doNormalizeVowelEnding) {
      text = this._normalizeVowelEnding(text)
    }

    return text
  }

  getCharStats (text) {
    console.log(
      text.match(new RegExp(NormalizerI.BYTE_ORDER_MARK, 'g'))?.length || 0
    )
    console.log(
      text.match(new RegExp(NormalizerI.BYTE_ORDER_MARK_2, 'g'))?.length || 0
    )
    console.log(
      text.match(new RegExp(NormalizerI.WORD_JOINER, 'g'))?.length || 0
    )
    console.log(
      text.match(new RegExp(NormalizerI.SOFT_HYPHEN, 'g'))?.length || 0
    )

    console.log(
      text.match(new RegExp(NormalizerI.ZERO_WIDTH_SPACE, 'g'))?.length || 0
    )
    console.log(
      text.match(new RegExp(NormalizerI.NO_BREAK_SPACE, 'g'))?.length || 0
    )

    console.log(
      text.match(new RegExp(NormalizerI.ZERO_WIDTH_NON_JOINER, 'g'))?.length ||
        0
    )
    console.log(
      text.match(new RegExp(NormalizerI.ZERO_WIDTH_JOINER, 'g'))?.length || 0
    )
  }

  correctVisarga (text, visargaChar, charRange) {
    return text.replace(/([^\u0900-\u097f]):/g, '$1\u0903')
  }
}

class DevanagariNormalizer extends BaseNormalizer {
  /**
   * Normalizer for the Devanagari script. In addition to basic normalization by the super class,
   * * Replaces the composite characters containing nuktas by their decomposed form
   * * replace pipe character '|' by poorna virama character
   * * replace colon ':' by visarga if the colon follows a charcter in this script
   */

  static NUKTA = '\u093C'

  /**
   * Constructor for DevanagariNormalizer
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   * @param {string} nasalsMode - How to handle nasal characters
   * @param {boolean} doNormalizeChandras - Whether to normalize chandra characters
   * @param {boolean} doNormalizeVowelEnding - Whether to normalize vowel endings
   */
  constructor (
    lang = 'hi',
    removeNuktas = false,
    nasalsMode = 'do_nothing',
    doNormalizeChandras = false,
    doNormalizeVowelEnding = false
  ) {
    super(
      lang,
      removeNuktas,
      nasalsMode,
      doNormalizeChandras,
      doNormalizeVowelEnding
    )
  }

  normalize (text) {
    // Common normalization for Indic scripts
    text = super.normalize(text)

    // chandra a replacement for Marathi
    text = text.replace('\u0972', '\u090f')

    // decomposing Nukta based composite characters
    text = text.replace('\u0929', '\u0928' + DevanagariNormalizer.NUKTA)
    text = text.replace('\u0931', '\u0930' + DevanagariNormalizer.NUKTA)
    text = text.replace('\u0934', '\u0933' + DevanagariNormalizer.NUKTA)
    text = text.replace('\u0958', '\u0915' + DevanagariNormalizer.NUKTA)
    text = text.replace('\u0959', '\u0916' + DevanagariNormalizer.NUKTA)
    text = text.replace('\u095A', '\u0917' + DevanagariNormalizer.NUKTA)
    text = text.replace('\u095B', '\u091C' + DevanagariNormalizer.NUKTA)
    text = text.replace('\u095C', '\u0921' + DevanagariNormalizer.NUKTA)
    text = text.replace('\u095D', '\u0922' + DevanagariNormalizer.NUKTA)
    text = text.replace('\u095E', '\u092B' + DevanagariNormalizer.NUKTA)
    text = text.replace('\u095F', '\u092F' + DevanagariNormalizer.NUKTA)

    if (this.removeNuktas) {
      text = text.replace(new RegExp(DevanagariNormalizer.NUKTA, 'g'), '')
    }

    // replace pipe character for poorna virama
    text = text.replace('\u007c', '\u0964')

    // correct visarga
    text = text.replace(/([ऀ-ॿ]):/, '$1\u0903')

    return text
  }

  getCharStats (text) {
    super.getCharStats(text)

    console.log(text.match(/\u0929/g)?.length || 0)
    console.log(text.match(/\u0931/g)?.length || 0)
    console.log(text.match(/\u0934/g)?.length || 0)
    console.log(text.match(/\u0958/g)?.length || 0)
    console.log(text.match(/\u0959/g)?.length || 0)
    console.log(text.match(/\u095A/g)?.length || 0)
    console.log(text.match(/\u095B/g)?.length || 0)
    console.log(text.match(/\u095C/g)?.length || 0)
    console.log(text.match(/\u095D/g)?.length || 0)
    console.log(text.match(/\u095E/g)?.length || 0)
    console.log(text.match(/\u095F/g)?.length || 0)
  }
}

class GurmukhiNormalizer extends BaseNormalizer {
  /**
   * Normalizer for the Gurmukhi script. In addition to basic normalization by the super class,
   * * Replaces the composite characters containing nuktas by their decomposed form
   * * Replace the reserved character for poorna virama (if used) with the recommended generic Indic scripts poorna virama
   * * replace pipe character '|' by poorna virama character
   * * replace colon ':' by visarga if the colon follows a charcter in this script
   */

  static NUKTA = '\u0A3C'

  static VOWEL_NORM_MAPS = {
    // http://www.unicode.org/versions/Unicode12.1.0/ch12.pdf
    // Table 12-16
    ਅਾ: '\u0a06',
    ੲਿ: '\u0a07',
    ੲੀ: '\u0a08',
    ੳੁ: '\u0a09',
    ੳੂ: '\u0a0a',
    ੲੇ: '\u0a0f',
    ਅੈ: '\u0a10',
    ੳੋ: '\u0a13',
    ਅੌ: '\u0a14'
  }

  /**
   * Constructor for GurmukhiNormalizer
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   * @param {string} nasalsMode - How to handle nasal characters
   * @param {boolean} doNormalizeChandras - Whether to normalize chandra characters
   * @param {boolean} doNormalizeVowelEnding - Whether to normalize vowel endings
   * @param {boolean} doCanonicalizeAddak - Whether to canonicalize addak
   * @param {boolean} doCanonalizeTippi - Whether to canonicalize tippi
   * @param {boolean} doReplaceVowelBases - Whether to replace vowel bases
   */
  constructor (
    lang = 'pa',
    removeNuktas = false,
    nasalsMode = 'do_nothing',
    doNormalizeChandras = false,
    doNormalizeVowelEnding = false,
    doCanonicalizeAddak = false,
    doCanonalizeTippi = false,
    doReplaceVowelBases = false
  ) {
    super(
      lang,
      removeNuktas,
      nasalsMode,
      doNormalizeChandras,
      doNormalizeVowelEnding
    )
    this.doCanonicalizeAddak = doCanonicalizeAddak
    this.doCanonalizeTippi = doCanonalizeTippi
    this.doReplaceVowelBases = doReplaceVowelBases
  }

  _normalizeVowels (text) {
    // standard vowel replacements as per suggestions in
    // http://www.unicode.org/versions/Unicode12.1.0/ch12.pdf
    // Table 12-16
    for (const [k, v] of Object.entries(GurmukhiNormalizer.VOWEL_NORM_MAPS)) {
      text = text.replace(new RegExp(k, 'g'), v)
    }

    // If these special characters occur without any diacritic, replace them with closet
    // equivalent vowels
    if (this.doReplaceVowelBases) {
      text = text.replace(/\u0a72/g, '\u0a07')
      text = text.replace(/\u0a73/g, '\u0a09')
    }

    return text
  }

  normalize (text) {
    // Addak
    if (this.doCanonicalizeAddak) {
      // replace addak+consonant with consonat+halant+consonant
      text = text.replace(/\u0a71(.)/g, '$1\u0a4d$1')
    }

    // Tippi
    if (this.doCanonalizeTippi) {
      text = text.replace(/\u0a70/g, '\u0a02')
    }

    // Vowels: Gurumuki has multiple ways of representing independent vowels due
    // to the characters 'iri' and 'ura'.
    text = this._normalizeVowels(text)

    // common normalization for Indic scripts
    text = super.normalize(text)

    // decomposing Nukta based composite characters
    text = text.replace('\u0a33', '\u0a32' + GurmukhiNormalizer.NUKTA)
    text = text.replace('\u0a36', '\u0a38' + GurmukhiNormalizer.NUKTA)
    text = text.replace('\u0a59', '\u0a16' + GurmukhiNormalizer.NUKTA)
    text = text.replace('\u0a5a', '\u0a17' + GurmukhiNormalizer.NUKTA)
    text = text.replace('\u0a5b', '\u0a1c' + GurmukhiNormalizer.NUKTA)
    text = text.replace('\u0a5e', '\u0a2b' + GurmukhiNormalizer.NUKTA)

    if (this.removeNuktas) {
      text = text.replace(new RegExp(GurmukhiNormalizer.NUKTA, 'g'), '')
    }

    // replace the poorna virama codes specific to script
    // with generic Indic script codes
    text = text.replace('\u0a64', '\u0964')
    text = text.replace('\u0a65', '\u0965')

    // replace pipe character for poorna virama
    text = text.replace('\u007c', '\u0964')

    // correct visarga
    text = text.replace(/([਀-੿]):/, '$1\u0a03')

    return text
  }
}

class GujaratiNormalizer extends BaseNormalizer {
  /**
   * Normalizer for the Gujarati script. In addition to basic normalization by the super class,
   * * Replace the reserved character for poorna virama (if used) with the recommended generic Indic scripts poorna virama
   * * replace colon ':' by visarga if the colon follows a charcter in this script
   */

  static NUKTA = '\u0ABC'

  /**
   * Constructor for GujaratiNormalizer
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   * @param {string} nasalsMode - How to handle nasal characters
   * @param {boolean} doNormalizeChandras - Whether to normalize chandra characters
   * @param {boolean} doNormalizeVowelEnding - Whether to normalize vowel endings
   */
  constructor (
    lang = 'gu',
    removeNuktas = false,
    nasalsMode = 'do_nothing',
    doNormalizeChandras = false,
    doNormalizeVowelEnding = false
  ) {
    super(
      lang,
      removeNuktas,
      nasalsMode,
      doNormalizeChandras,
      doNormalizeVowelEnding
    )
  }

  normalize (text) {
    // common normalization for Indic scripts
    text = super.normalize(text)

    // decomposing Nukta based composite characters
    if (this.removeNuktas) {
      text = text.replace(new RegExp(GujaratiNormalizer.NUKTA, 'g'), '')
    }

    // replace the poorna virama codes specific to script
    // with generic Indic script codes
    text = text.replace('\u0ae4', '\u0964')
    text = text.replace('\u0ae5', '\u0965')

    // correct visarga
    text = text.replace(/([઀-૿]):/, '$1\u0a83')

    return text
  }
}

class OriyaNormalizer extends BaseNormalizer {
  /**
   * Normalizer for the Oriya script. In addition to basic normalization by the super class,
   * * Replaces the composite characters containing nuktas by their decomposed form
   * * Replace the reserved character for poorna virama (if used) with the recommended generic Indic scripts poorna virama
   * * Canonicalize two part dependent vowels
   * * Replace 'va' with 'ba'
   * * replace pipe character '|' by poorna virama character
   * * replace colon ':' by visarga if the colon follows a charcter in this script
   */

  static NUKTA = '\u0B3C'

  static VOWEL_NORM_MAPS = {
    // See Table 12-22 in http://www.unicode.org/versions/Unicode12.1.0/ch12.pdf
    ଅା: '\u0b06',
    ଏୗ: '\u0b10',
    ଓୗ: '\u0b14'
  }

  /**
   * Constructor for OriyaNormalizer
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   * @param {string} nasalsMode - How to handle nasal characters
   * @param {boolean} doNormalizeChandras - Whether to normalize chandra characters
   * @param {boolean} doNormalizeVowelEnding - Whether to normalize vowel endings
   * @param {boolean} doRemapWa - Whether to remap wa
   */
  constructor (
    lang = 'or',
    removeNuktas = false,
    nasalsMode = 'do_nothing',
    doNormalizeChandras = false,
    doNormalizeVowelEnding = false,
    doRemapWa = false
  ) {
    super(
      lang,
      removeNuktas,
      nasalsMode,
      doNormalizeChandras,
      doNormalizeVowelEnding
    )
    this.doRemapWa = doRemapWa
  }

  normalize (text) {
    // common normalization for Indic scripts
    text = super.normalize(text)

    // standard vowel replacements as per suggestions in Unicode documents
    for (const [k, v] of Object.entries(OriyaNormalizer.VOWEL_NORM_MAPS)) {
      text = text.replace(new RegExp(k, 'g'), v)
    }

    // decomposing Nukta based composite characters
    text = text.replace('\u0b5c', '\u0b21' + OriyaNormalizer.NUKTA)
    text = text.replace('\u0b5d', '\u0b22' + OriyaNormalizer.NUKTA)

    if (this.removeNuktas) {
      text = text.replace(new RegExp(OriyaNormalizer.NUKTA, 'g'), '')
    }

    // replace the poorna virama codes specific to script
    // with generic Indic script codes
    text = text.replace('\u0b64', '\u0964')
    text = text.replace('\u0b65', '\u0965')

    // replace pipe character for poorna virama
    text = text.replace('\u0b7c', '\u0964')

    // replace wa with ba
    if (this.doRemapWa) {
      text = text.replace('\u0b71', '\u0b2c')
    }

    // replace va with ba
    // NOTE: documentation (chapter on Indic scripts) and codepoint chart seem contradictory
    // (this applied to wa to ba rule also above)
    text = text.replace('\u0b35', '\u0b2c')

    // AI dependent vowel sign
    text = text.replace('\u0b47\u0b56', '\u0b58')

    // two part dependent vowels
    text = text.replace('\u0b47\u0b3e', '\u0b4b')
    text = text.replace('\u0b47\u0b57', '\u0b4c')

    // additional consonant - not clear how to handle this
    // ignore

    // correct visarga
    text = text.replace(/([଀-୿]):/, '$1\u0b03')

    return text
  }
}

class BengaliNormalizer extends BaseNormalizer {
  /**
   * Normalizer for the Bengali script. In addition to basic normalization by the super class,
   * * Replaces the composite characters containing nuktas by their decomposed form
   * * Replace the reserved character for poorna virama (if used) with the recommended generic Indic scripts poorna virama
   * * Canonicalize two part dependent vowels
   * * replace pipe character '|' by poorna virama character
   * * replace colon ':' by visarga if the colon follows a charcter in this script
   */

  static NUKTA = '\u09BC'

  /**
   * Constructor for BengaliNormalizer
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   * @param {string} nasalsMode - How to handle nasal characters
   * @param {boolean} doNormalizeChandras - Whether to normalize chandra characters
   * @param {boolean} doNormalizeVowelEnding - Whether to normalize vowel endings
   * @param {boolean} doRemapAssameseChars - Whether to remap Assamese characters
   */
  constructor (
    lang = 'bn',
    removeNuktas = false,
    nasalsMode = 'do_nothing',
    doNormalizeChandras = false,
    doNormalizeVowelEnding = false,
    doRemapAssameseChars = false
  ) {
    super(
      lang,
      removeNuktas,
      nasalsMode,
      doNormalizeChandras,
      doNormalizeVowelEnding
    )
    this.doRemapAssameseChars = doRemapAssameseChars
  }

  normalize (text) {
    // common normalization for Indic scripts
    text = super.normalize(text)

    // decomposing Nukta based composite characters
    text = text.replace('\u09dc', '\u09a1' + BengaliNormalizer.NUKTA)
    text = text.replace('\u09dd', '\u09a2' + BengaliNormalizer.NUKTA)
    text = text.replace('\u09df', '\u09af' + BengaliNormalizer.NUKTA)

    if (this.removeNuktas) {
      text = text.replace(new RegExp(BengaliNormalizer.NUKTA, 'g'), '')
    }

    if (this.doRemapAssameseChars && this.lang === 'as') {
      text = text.replace('\u09f0', '\u09b0') // 'ra' character
      text = text.replace('\u09f1', '\u09ac') // 'va' character
    }

    // replace the poorna virama codes specific to script
    // with generic Indic script codes
    text = text.replace('\u09e4', '\u0964')
    text = text.replace('\u09e5', '\u0965')

    // replace pipe character for poorna virama
    text = text.replace('\u007c', '\u0964')
    // replace bengali currency numerator four for poorna virama (it looks similar and is used as a substitute)
    text = text.replace('\u09f7', '\u0964')

    // two part dependent vowels
    text = text.replace('\u09c7\u09be', '\u09cb')
    text = text.replace('\u09c7\u09d7', '\u09cc')

    // correct visarga
    text = text.replace(/([ঀ-৿]):/, '$1\u0983')

    return text
  }
}

class TamilNormalizer extends BaseNormalizer {
  /**
   * Normalizer for the Tamil script. In addition to basic normalization by the super class,
   * * Replace the reserved character for poorna virama (if used) with the recommended generic Indic scripts poorna virama
   * * canonicalize two-part dependent vowel signs
   * * replace colon ':' by visarga if the colon follows a charcter in this script
   */

  /**
   * Constructor for TamilNormalizer
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   * @param {string} nasalsMode - How to handle nasal characters
   * @param {boolean} doNormalizeChandras - Whether to normalize chandra characters
   * @param {boolean} doNormalizeVowelEnding - Whether to normalize vowel endings
   */
  constructor (
    lang = 'ta',
    removeNuktas = false,
    nasalsMode = 'do_nothing',
    doNormalizeChandras = false,
    doNormalizeVowelEnding = false
  ) {
    super(
      lang,
      removeNuktas,
      nasalsMode,
      doNormalizeChandras,
      doNormalizeVowelEnding
    )
  }

  normalize (text) {
    // common normalization for Indic scripts
    text = super.normalize(text)

    // replace the poorna virama codes specific to script
    // with generic Indic script codes
    text = text.replace('\u0be4', '\u0964')
    text = text.replace('\u0be5', '\u0965')

    // two part dependent vowels
    text = text.replace('\u0b92\u0bd7', '\u0b94')
    text = text.replace('\u0bc6\u0bbe', '\u0bca')
    text = text.replace('\u0bc7\u0bbe', '\u0bcb')
    text = text.replace('\u0bc6\u0bd7', '\u0bcc')

    // correct visarga
    text = text.replace(/([஀-௿]):/, '$1\u0b83')

    return text
  }
}

class TeluguNormalizer extends BaseNormalizer {
  /**
   * Normalizer for the Telugu script. In addition to basic normalization by the super class,
   * * Replace the reserved character for poorna virama (if used) with the recommended generic Indic scripts poorna virama
   * * canonicalize two-part dependent vowel signs
   * * replace colon ':' by visarga if the colon follows a charcter in this script
   */

  /**
   * Constructor for TeluguNormalizer
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   * @param {string} nasalsMode - How to handle nasal characters
   * @param {boolean} doNormalizeChandras - Whether to normalize chandra characters
   * @param {boolean} doNormalizeVowelEnding - Whether to normalize vowel endings
   */
  constructor (
    lang = 'te',
    removeNuktas = false,
    nasalsMode = 'do_nothing',
    doNormalizeChandras = false,
    doNormalizeVowelEnding = false
  ) {
    super(
      lang,
      removeNuktas,
      nasalsMode,
      doNormalizeChandras,
      doNormalizeVowelEnding
    )
  }

  normalize (text) {
    // common normalization for Indic scripts
    text = super.normalize(text)

    // replace the poorna virama codes specific to script
    // with generic Indic script codes
    text = text.replace('\u0c64', '\u0964')
    text = text.replace('\u0c65', '\u0965')

    // dependent vowels
    text = text.replace('\u0c46\u0c56', '\u0c48')

    // correct visarga
    text = text.replace(/([౦-౿]):/, '$1\u0c03')

    return text
  }

  getCharStats (text) {
    // Empty implementation
  }
}

class KannadaNormalizer extends BaseNormalizer {
  /**
   * Normalizer for the Kannada script. In addition to basic normalization by the super class,
   * * Replace the reserved character for poorna virama (if used) with the recommended generic Indic scripts poorna virama
   * * canonicalize two-part dependent vowel signs
   * * replace colon ':' by visarga if the colon follows a charcter in this script
   */

  /**
   * Constructor for KannadaNormalizer
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   * @param {string} nasalsMode - How to handle nasal characters
   * @param {boolean} doNormalizeChandras - Whether to normalize chandra characters
   * @param {boolean} doNormalizeVowelEnding - Whether to normalize vowel endings
   */
  constructor (
    lang = 'kn',
    removeNuktas = false,
    nasalsMode = 'do_nothing',
    doNormalizeChandras = false,
    doNormalizeVowelEnding = false
  ) {
    super(
      lang,
      removeNuktas,
      nasalsMode,
      doNormalizeChandras,
      doNormalizeVowelEnding
    )
  }

  normalize (text) {
    // common normalization for Indic scripts
    text = super.normalize(text)

    // replace the poorna virama codes specific to script
    // with generic Indic script codes
    text = text.replace('\u0ce4', '\u0964')
    text = text.replace('\u0ce5', '\u0965')

    // dependent vowels
    text = text.replace('\u0cbf\u0cd5', '\u0cc0')
    text = text.replace('\u0cc6\u0cd5', '\u0cc7')
    text = text.replace('\u0cc6\u0cd6', '\u0cc8')
    text = text.replace('\u0cc6\u0cc2', '\u0cca')
    text = text.replace('\u0cca\u0cd5', '\u0ccb')

    // correct visarga
    text = text.replace(/([ಂ-ೲ]):/, '$1\u0c83')

    return text
  }
}

class MalayalamNormalizer extends BaseNormalizer {
  /**
   * Normalizer for the Malayalam script. In addition to basic normalization by the super class,
   * * Replace the reserved character for poorna virama (if used) with the recommended generic Indic scripts poorna virama
   * * canonicalize two-part dependent vowel signs
   * * Change from old encoding of chillus (till Unicode 5.0) to new encoding
   * * replace colon ':' by visarga if the colon follows a charcter in this script
   */

  static CHILLU_CHAR_MAP = {
    ൺ: '\u0d23',
    ൻ: '\u0d28',
    ർ: '\u0d30',
    ൽ: '\u0d32',
    ൾ: '\u0d33',
    ൿ: '\u0d15'
  }

  _canonicalizeChillus (text) {
    for (const [chillu, char] of Object.entries(
      MalayalamNormalizer.CHILLU_CHAR_MAP
    )) {
      text = text.replace(new RegExp(chillu, 'g'), `${char}\u0d4d`)
    }
    return text
  }

  _correctGeminatedT (text) {
    return text.replace('\u0d31\u0d4d\u0d31', '\u0d1f\u0d4d\u0d1f')
  }

  /**
   * Constructor for MalayalamNormalizer
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   * @param {string} nasalsMode - How to handle nasal characters
   * @param {boolean} doNormalizeChandras - Whether to normalize chandra characters
   * @param {boolean} doNormalizeVowelEnding - Whether to normalize vowel endings
   * @param {boolean} doCanonicalizeChillus - Whether to canonicalize chillus
   * @param {boolean} doCorrectGeminatedT - Whether to correct geminated T
   */
  constructor (
    lang = 'ml',
    removeNuktas = false,
    nasalsMode = 'do_nothing',
    doNormalizeChandras = false,
    doNormalizeVowelEnding = false,
    doCanonicalizeChillus = false,
    doCorrectGeminatedT = false
  ) {
    super(
      lang,
      removeNuktas,
      nasalsMode,
      doNormalizeChandras,
      doNormalizeVowelEnding
    )
    this.doCanonicalizeChillus = doCanonicalizeChillus
    this.doCorrectGeminatedT = doCorrectGeminatedT
  }

  normalize (text) {
    // Change from old encoding of chillus (till Unicode 5.0) to new encoding
    text = text.replace('\u0d23\u0d4d\u200d', '\u0d7a')
    text = text.replace('\u0d28\u0d4d\u200d', '\u0d7b')
    text = text.replace('\u0d30\u0d4d\u200d', '\u0d7c')
    text = text.replace('\u0d32\u0d4d\u200d', '\u0d7d')
    text = text.replace('\u0d33\u0d4d\u200d', '\u0d7e')
    text = text.replace('\u0d15\u0d4d\u200d', '\u0d7f')

    // Normalize chillus
    if (this.doCanonicalizeChillus) {
      text = this._canonicalizeChillus(text)
    }

    // common normalization for Indic scripts
    text = super.normalize(text)

    // replace the poorna virama codes specific to script
    // with generic Indic script codes
    text = text.replace('\u0d64', '\u0964')
    text = text.replace('\u0d65', '\u0965')

    // dependent vowels
    text = text.replace('\u0d46\u0d3e', '\u0d4a')
    text = text.replace('\u0d47\u0d3e', '\u0d4b')

    // au forms
    text = text.replace('\u0d46\u0d57', '\u0d4c')
    text = text.replace('\u0d57', '\u0d4c')

    // correct geminated T
    if (this.doCorrectGeminatedT) {
      text = this._correctGeminatedT(text)
    }

    // correct visarga
    text = text.replace(/([ം-ൿ]):/, '$1\u0d03')

    return text
  }
}

class UrduNormalizer extends NormalizerI {
  /**
   * Uses UrduHack library.
   * https://docs.urduhack.com/en/stable/_modules/urduhack/normalization/character.html#normalize
   * @param {string} lang - Language code
   * @param {boolean} removeNuktas - Whether to remove nukta characters
   */
  constructor (lang, removeNuktas = true) {
    super()
    this.lang = lang
    this.removeNuktas = removeNuktas

    try {
      // This is a placeholder for the functionality that would be imported from urduhack
      // In a real implementation, you would need to include equivalent JavaScript functionality
      this.normalizeWhitespace = (text) => text.replace(/\s+/g, ' ')
      this.digitsSpace = (text) =>
        text
          .replace(/(\d)([^\d\s])/g, '$1 $2')
          .replace(/([^\d\s])(\d)/g, '$1 $2')
      this.allPunctuationsSpace = (text) =>
        text
          .replace(/([^\w\s])([^\s])/g, '$1 $2')
          .replace(/([^\s])([^\w\s])/g, '$1 $2')
      this.englishCharactersSpace = (text) =>
        text
          .replace(/([a-zA-Z])([^a-zA-Z\s])/g, '$1 $2')
          .replace(/([^a-zA-Z\s])([a-zA-Z])/g, '$1 $2')
      this.removeDiacritics = (text) => text // Placeholder
      this.normalizeCharacters = (text) => text // Placeholder
      this.normalizeCombineCharacters = (text) => text // Placeholder

      console.warn(
        'Warning: UrduNormalizer is using placeholder implementations. For full functionality, equivalent JavaScript implementations of urduhack functions are needed.'
      )
    } catch (e) {
      console.error('Error loading urduhack functions:', e)
    }
  }

  normalize (text) {
    text = this._normalizePunctuations(text)
    text = this.normalizeWhitespace(text)
    if (this.removeNuktas) {
      text = this.removeDiacritics(text)
    }
    text = this.normalizeCharacters(text)
    text = this.normalizeCombineCharacters(text)
    text = this.digitsSpace(text)
    text = this.allPunctuationsSpace(text)
    text = this.englishCharactersSpace(text)
    return text
  }
}

class IndicNormalizerFactory {
  /**
   * Factory class to create language specific normalizers.
   */

  /**
   * Get the language specific normalizer
   * @param {string} language - Language code
   * @param {Object} options - Options for normalizer
   * @returns {NormalizerI} - Language specific normalizer
   */
  static getNormalizer (language, options = {}) {
    let normalizer = null
    if (['hi', 'mr', 'sa', 'kK', 'ne', 'sd'].includes(language)) {
      normalizer = new DevanagariNormalizer(language, options)
    } else if (['ur'].includes(language)) {
      normalizer = new UrduNormalizer(language, options)
    } else if (['pa'].includes(language)) {
      normalizer = new GurmukhiNormalizer(language, options)
    } else if (['gu'].includes(language)) {
      normalizer = new GujaratiNormalizer(language, options)
    } else if (['bn'].includes(language)) {
      normalizer = new BengaliNormalizer(language, options)
    } else if (['as'].includes(language)) {
      normalizer = new BengaliNormalizer(language, options)
    } else if (['or'].includes(language)) {
      normalizer = new OriyaNormalizer(language, options)
    } else if (['ml'].includes(language)) {
      normalizer = new MalayalamNormalizer(language, options)
    } else if (['kn'].includes(language)) {
      normalizer = new KannadaNormalizer(language, options)
    } else if (['ta'].includes(language)) {
      normalizer = new TamilNormalizer(language, options)
    } else if (['te'].includes(language)) {
      normalizer = new TeluguNormalizer(language, options)
    } else {
      normalizer = new BaseNormalizer(language, options)
    }

    return normalizer
  }

  /**
   * Check if a language is supported
   * @param {string} language - Language code
   * @returns {boolean} - Whether the language is supported
   */
  static isLanguageSupported (language) {
    return [
      'hi',
      'mr',
      'sa',
      'kK',
      'ne',
      'sd',
      'ur',
      'pa',
      'gu',
      'bn',
      'as',
      'or',
      'ml',
      'kn',
      'ta',
      'te'
    ].includes(language)
  }
}

module.exports = {
  NormalizerI,
  BaseNormalizer,
  DevanagariNormalizer,
  GurmukhiNormalizer,
  GujaratiNormalizer,
  OriyaNormalizer,
  BengaliNormalizer,
  TamilNormalizer,
  TeluguNormalizer,
  KannadaNormalizer,
  MalayalamNormalizer,
  UrduNormalizer,
  IndicNormalizerFactory
}
