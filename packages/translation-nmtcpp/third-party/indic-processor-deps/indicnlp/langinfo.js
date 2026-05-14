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

// Language codes
const LC_TA = 'ta'

const SCRIPT_RANGES = {
  pa: [0x0a00, 0x0a7f],
  gu: [0x0a80, 0x0aff],
  or: [0x0b00, 0x0b7f],
  ta: [0x0b80, 0x0bff],
  te: [0x0c00, 0x0c7f],
  kn: [0x0c80, 0x0cff],
  ml: [0x0d00, 0x0d7f],
  si: [0x0d80, 0x0dff],
  hi: [0x0900, 0x097f],
  mr: [0x0900, 0x097f],
  kK: [0x0900, 0x097f],
  sa: [0x0900, 0x097f],
  ne: [0x0900, 0x097f],
  sd: [0x0900, 0x097f],
  bn: [0x0980, 0x09ff],
  as: [0x0980, 0x09ff]
}

const DRAVIDIAN_LANGUAGES = ['ta', 'te', 'kn', 'ml']
const IE_LANGUAGES = [
  'hi',
  'mr',
  'kK',
  'sa',
  'ne',
  'sd',
  'bn',
  'as',
  'pa',
  'gu',
  'or',
  'si'
]
const DANDA_DELIM_LANGUAGES = ['as', 'bn', 'hi', 'ne', 'or', 'pa', 'sa', 'sd']

const URDU_RANGES = [
  [0x0600, 0x06ff],
  [0x0750, 0x077f],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff]
]

const COORDINATED_RANGE_START_INCLUSIVE = 0
const COORDINATED_RANGE_END_INCLUSIVE = 0x6f

const NUMERIC_OFFSET_START = 0x66
const NUMERIC_OFFSET_END = 0x6f

const HALANTA_OFFSET = 0x4d
const AUM_OFFSET = 0x50
const NUKTA_OFFSET = 0x3c

const RUPEE_SIGN = 0x20b9

const DANDA = 0x0964
const DOUBLE_DANDA = 0x0965

// TODO: add missing fricatives and approximants
const VELAR_RANGE = [0x15, 0x19]
const PALATAL_RANGE = [0x1a, 0x1e]
const RETROFLEX_RANGE = [0x1f, 0x23]
const DENTAL_RANGE = [0x24, 0x29]
const LABIAL_RANGE = [0x2a, 0x2e]

// verify
const VOICED_LIST = [
  0x17, 0x18, 0x1c, 0x1d, 0x21, 0x22, 0x26, 0x27, 0x2c, 0x2d
]
const UNVOICED_LIST = [
  0x15, 0x16, 0x1a, 0x1b, 0x1f, 0x20, 0x24, 0x25, 0x2a, 0x2b
] // TODO: add sibilants/sonorants
const ASPIRATED_LIST = [
  0x16, 0x18, 0x1b, 0x1d, 0x20, 0x22, 0x25, 0x27, 0x2b, 0x2d
]
const UNASPIRATED_LIST = [
  0x15, 0x17, 0x1a, 0x1c, 0x1f, 0x21, 0x24, 0x26, 0x2a, 0x2c
]
const NASAL_LIST = [0x19, 0x1e, 0x23, 0x28, 0x29, 0x2d]
const FRICATIVE_LIST = [0x36, 0x37, 0x38]
const APPROXIMANT_LIST = [0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35]

// TODO: ha has to be properly categorized

/**
 * Returns True if danda/double danda is a possible delimiter for the language
 * @param {string} lang - Language code
 * @returns {boolean} True if danda/double danda is a possible delimiter
 */
function isDandaDelim (lang) {
  return DANDA_DELIM_LANGUAGES.includes(lang)
}

/**
 * Get character offset - applicable to Brahmi derived Indic scripts
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {number} Character offset
 */
function getOffset (c, lang) {
  return c.charCodeAt(0) - SCRIPT_RANGES[lang][0]
}

/**
 * Convert offset to character - applicable to Brahmi derived Indic scripts
 * @param {number} c - Character offset
 * @param {string} lang - Language code
 * @returns {string} Character
 */
function offsetToChar (c, lang) {
  return String.fromCharCode(c + SCRIPT_RANGES[lang][0])
}

/**
 * Check if offset is in coordinated range - applicable to Brahmi derived Indic scripts
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if in coordinated range
 */
function inCoordinatedRange (cOffset) {
  return (
    cOffset >= COORDINATED_RANGE_START_INCLUSIVE &&
    cOffset <= COORDINATED_RANGE_END_INCLUSIVE
  )
}

/**
 * Check if character belongs to Indic language - applicable to Brahmi derived Indic scripts
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character belongs to Indic language
 */
function isIndiclangChar (c, lang) {
  const charCode = c.charCodeAt(0)
  const o = getOffset(c, lang)
  return (
    (o >= 0 && o <= 0x7f) || charCode === DANDA || charCode === DOUBLE_DANDA
  )
}

/**
 * Is the character a vowel
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a vowel
 */
function isVowel (c, lang) {
  const o = getOffset(c, lang)
  return o >= 0x04 && o <= 0x14
}

/**
 * Is the character a vowel sign (maatraa)
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a vowel sign
 */
function isVowelSign (c, lang) {
  const o = getOffset(c, lang)
  return o >= 0x3e && o <= 0x4c
}

/**
 * Is the character the halanta character
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is halanta
 */
function isHalanta (c, lang) {
  const o = getOffset(c, lang)
  return o === HALANTA_OFFSET
}

/**
 * Is the character the nukta character
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is nukta
 */
function isNukta (c, lang) {
  const o = getOffset(c, lang)
  return o === NUKTA_OFFSET
}

/**
 * Is the character the aum character
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is aum
 */
function isAum (c, lang) {
  const o = getOffset(c, lang)
  return o === AUM_OFFSET
}

/**
 * Is the character a consonant
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a consonant
 */
function isConsonant (c, lang) {
  const o = getOffset(c, lang)
  return o >= 0x15 && o <= 0x39
}

/**
 * Is the character a velar
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a velar
 */
function isVelar (c, lang) {
  const o = getOffset(c, lang)
  return o >= VELAR_RANGE[0] && o <= VELAR_RANGE[1]
}

/**
 * Is the character a palatal
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a palatal
 */
function isPalatal (c, lang) {
  const o = getOffset(c, lang)
  return o >= PALATAL_RANGE[0] && o <= PALATAL_RANGE[1]
}

/**
 * Is the character a retroflex
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a retroflex
 */
function isRetroflex (c, lang) {
  const o = getOffset(c, lang)
  return o >= RETROFLEX_RANGE[0] && o <= RETROFLEX_RANGE[1]
}

/**
 * Is the character a dental
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a dental
 */
function isDental (c, lang) {
  const o = getOffset(c, lang)
  return o >= DENTAL_RANGE[0] && o <= DENTAL_RANGE[1]
}

/**
 * Is the character a labial
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a labial
 */
function isLabial (c, lang) {
  const o = getOffset(c, lang)
  return o >= LABIAL_RANGE[0] && o <= LABIAL_RANGE[1]
}

/**
 * Is the character a voiced consonant
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a voiced consonant
 */
function isVoiced (c, lang) {
  const o = getOffset(c, lang)
  return VOICED_LIST.includes(o)
}

/**
 * Is the character an unvoiced consonant
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is an unvoiced consonant
 */
function isUnvoiced (c, lang) {
  const o = getOffset(c, lang)
  return UNVOICED_LIST.includes(o)
}

/**
 * Is the character an aspirated consonant
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is an aspirated consonant
 */
function isAspirated (c, lang) {
  const o = getOffset(c, lang)
  return ASPIRATED_LIST.includes(o)
}

/**
 * Is the character an unaspirated consonant
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is an unaspirated consonant
 */
function isUnaspirated (c, lang) {
  const o = getOffset(c, lang)
  return UNASPIRATED_LIST.includes(o)
}

/**
 * Is the character a nasal consonant
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a nasal consonant
 */
function isNasal (c, lang) {
  const o = getOffset(c, lang)
  return NASAL_LIST.includes(o)
}

/**
 * Is the character a fricative consonant
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a fricative consonant
 */
function isFricative (c, lang) {
  const o = getOffset(c, lang)
  return FRICATIVE_LIST.includes(o)
}

/**
 * Is the character an approximant consonant
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is an approximant consonant
 */
function isApproximant (c, lang) {
  const o = getOffset(c, lang)
  return APPROXIMANT_LIST.includes(o)
}

/**
 * Is the character a number
 * @param {string} c - Character
 * @param {string} lang - Language code
 * @returns {boolean} True if character is a number
 */
function isNumber (c, lang) {
  const o = getOffset(c, lang)
  return o >= 0x66 && o <= 0x6f
}

// Offset-based functions

/**
 * Is the offset a vowel
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a vowel
 */
function isVowelOffset (cOffset) {
  return cOffset >= 0x04 && cOffset <= 0x14
}

/**
 * Is the offset a vowel sign (maatraa)
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a vowel sign
 */
function isVowelSignOffset (cOffset) {
  return cOffset >= 0x3e && cOffset <= 0x4c
}

/**
 * Is the offset the halanta offset
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is halanta
 */
function isHalantaOffset (cOffset) {
  return cOffset === HALANTA_OFFSET
}

/**
 * Is the offset the nukta offset
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is nukta
 */
function isNuktaOffset (cOffset) {
  return cOffset === NUKTA_OFFSET
}

/**
 * Is the offset a vowel sign (maatraa)
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is aum
 */
function isAumOffset (cOffset) {
  return cOffset === AUM_OFFSET
}

/**
 * Is the offset a consonant
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a consonant
 */
function isConsonantOffset (cOffset) {
  return cOffset >= 0x15 && cOffset <= 0x39
}

/**
 * Is the offset a velar
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a velar
 */
function isVelarOffset (cOffset) {
  return cOffset >= VELAR_RANGE[0] && cOffset <= VELAR_RANGE[1]
}

/**
 * Is the offset a palatal
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a palatal
 */
function isPalatalOffset (cOffset) {
  return cOffset >= PALATAL_RANGE[0] && cOffset <= PALATAL_RANGE[1]
}

/**
 * Is the offset a retroflex
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a retroflex
 */
function isRetroflexOffset (cOffset) {
  return cOffset >= RETROFLEX_RANGE[0] && cOffset <= RETROFLEX_RANGE[1]
}

/**
 * Is the offset a dental
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a dental
 */
function isDentalOffset (cOffset) {
  return cOffset >= DENTAL_RANGE[0] && cOffset <= DENTAL_RANGE[1]
}

/**
 * Is the offset a labial
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a labial
 */
function isLabialOffset (cOffset) {
  return cOffset >= LABIAL_RANGE[0] && cOffset <= LABIAL_RANGE[1]
}

/**
 * Is the offset a voiced consonant
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a voiced consonant
 */
function isVoicedOffset (cOffset) {
  return VOICED_LIST.includes(cOffset)
}

/**
 * Is the offset an unvoiced consonant
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is an unvoiced consonant
 */
function isUnvoicedOffset (cOffset) {
  return UNVOICED_LIST.includes(cOffset)
}

/**
 * Is the offset an aspirated consonant
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is an aspirated consonant
 */
function isAspiratedOffset (cOffset) {
  return ASPIRATED_LIST.includes(cOffset)
}

/**
 * Is the offset an unaspirated consonant
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is an unaspirated consonant
 */
function isUnaspiratedOffset (cOffset) {
  return UNASPIRATED_LIST.includes(cOffset)
}

/**
 * Is the offset a nasal consonant
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a nasal consonant
 */
function isNasalOffset (cOffset) {
  return NASAL_LIST.includes(cOffset)
}

/**
 * Is the offset a fricative consonant
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a fricative consonant
 */
function isFricativeOffset (cOffset) {
  return FRICATIVE_LIST.includes(cOffset)
}

/**
 * Is the offset an approximant consonant
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is an approximant consonant
 */
function isApproximantOffset (cOffset) {
  return APPROXIMANT_LIST.includes(cOffset)
}

/**
 * Is the offset a number
 * @param {number} cOffset - Character offset
 * @returns {boolean} True if offset is a number
 */
function isNumberOffset (cOffset) {
  return cOffset >= 0x66 && cOffset <= 0x6f
}

module.exports = {
  LC_TA,
  SCRIPT_RANGES,
  DRAVIDIAN_LANGUAGES,
  IE_LANGUAGES,
  DANDA_DELIM_LANGUAGES,
  URDU_RANGES,
  COORDINATED_RANGE_START_INCLUSIVE,
  COORDINATED_RANGE_END_INCLUSIVE,
  NUMERIC_OFFSET_START,
  NUMERIC_OFFSET_END,
  HALANTA_OFFSET,
  AUM_OFFSET,
  NUKTA_OFFSET,
  RUPEE_SIGN,
  DANDA,
  DOUBLE_DANDA,
  VELAR_RANGE,
  PALATAL_RANGE,
  RETROFLEX_RANGE,
  DENTAL_RANGE,
  LABIAL_RANGE,
  VOICED_LIST,
  UNVOICED_LIST,
  ASPIRATED_LIST,
  UNASPIRATED_LIST,
  NASAL_LIST,
  FRICATIVE_LIST,
  APPROXIMANT_LIST,
  isDandaDelim,
  getOffset,
  offsetToChar,
  inCoordinatedRange,
  isIndiclangChar,
  isVowel,
  isVowelSign,
  isHalanta,
  isNukta,
  isAum,
  isConsonant,
  isVelar,
  isPalatal,
  isRetroflex,
  isDental,
  isLabial,
  isVoiced,
  isUnvoiced,
  isAspirated,
  isUnaspirated,
  isNasal,
  isFricative,
  isApproximant,
  isNumber,
  isVowelOffset,
  isVowelSignOffset,
  isHalantaOffset,
  isNuktaOffset,
  isAumOffset,
  isConsonantOffset,
  isVelarOffset,
  isPalatalOffset,
  isRetroflexOffset,
  isDentalOffset,
  isLabialOffset,
  isVoicedOffset,
  isUnvoicedOffset,
  isAspiratedOffset,
  isUnaspiratedOffset,
  isNasalOffset,
  isFricativeOffset,
  isApproximantOffset,
  isNumberOffset
}
