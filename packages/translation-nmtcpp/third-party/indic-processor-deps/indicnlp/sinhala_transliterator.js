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

/**
 * A Devanagari to Sinhala transliterator based on explicit Unicode Mapping
 */
class SinhalaDevanagariTransliterator {
  /**
   * Map of Sinhala to Devanagari Unicode characters
   */
  static sinhalaDevnagMap = {
    '\u0d82': '\u0902',
    '\u0d83': '\u0903',
    '\u0d84': '\u0904',
    අ: '\u0905',
    ආ: '\u0906',
    ඇ: '\u090d',
    ඈ: '\u090d',
    ඉ: '\u0907',
    ඊ: '\u0908',
    උ: '\u0909',
    ඌ: '\u090a',
    ඍ: '\u090b',
    ඏ: '\u090c',
    එ: '\u090e',
    ඒ: '\u090f',
    ඓ: '\u0910',
    ඔ: '\u0912',
    ඕ: '\u0913',
    ඖ: '\u0914',
    ක: '\u0915',
    ඛ: '\u0916',
    ග: '\u0917',
    ඝ: '\u0918',
    ඞ: '\u0919',
    ඟ: '\u0919',
    ච: '\u091a',
    ඡ: '\u091b',
    ජ: '\u091c',
    ඣ: '\u091d',
    ඤ: '\u091e',
    ඥ: '\u091e',
    ඦ: '\u091e',
    ට: '\u091f',
    ඨ: '\u0920',
    ඩ: '\u0921',
    ඪ: '\u0922',
    ණ: '\u0923',
    ඬ: '\u0923',
    ත: '\u0924',
    ථ: '\u0925',
    ද: '\u0926',
    ධ: '\u0927',
    න: '\u0928',
    '\u0db2': '\u0928',
    ඳ: '\u0928',
    ප: '\u092a',
    ඵ: '\u092b',
    බ: '\u092c',
    භ: '\u092d',
    ම: '\u092e',
    ය: '\u092f',
    ර: '\u0930',
    ල: '\u0932',
    ළ: '\u0933',
    ව: '\u0935',
    ශ: '\u0936',
    ෂ: '\u0937',
    ස: '\u0938',
    හ: '\u0939',
    '\u0dcf': '\u093e',
    '\u0dd0': '\u0949',
    '\u0dd1': '\u0949',
    '\u0dd2': '\u093f',
    '\u0dd3': '\u0940',
    '\u0dd4': '\u0941',
    '\u0dd6': '\u0942',
    '\u0dd8': '\u0943',
    '\u0dd9': '\u0946',
    '\u0dda': '\u0947',
    '\u0ddb': '\u0948',
    '\u0ddc': '\u094a',
    '\u0ddd': '\u094b',
    '\u0dde': '\u094c',
    '\u0dca': '\u094d'
  }

  /**
   * Map of Devanagari to Sinhala Unicode characters
   */
  static devnagSinhalaMap = {
    '\u0900': '\u0d82',
    '\u0901': '\u0d82',
    '\u0902': '\u0d82',
    '\u0903': '\u0d83',
    ऄ: '\u0d84',
    अ: '\u0d85',
    आ: '\u0d86',
    इ: '\u0d89',
    ई: '\u0d8a',
    उ: '\u0d8b',
    ऊ: '\u0d8c',
    ऋ: '\u0d8d',
    ऌ: '\u0d8f',
    ऍ: '\u0d88',
    ऎ: '\u0d91',
    ए: '\u0d92',
    ऐ: '\u0d93',
    ऒ: '\u0d94',
    ओ: '\u0d95',
    औ: '\u0d96',
    क: '\u0d9a',
    ख: '\u0d9b',
    ग: '\u0d9c',
    घ: '\u0d9d',
    ङ: '\u0d9e',
    च: '\u0da0',
    छ: '\u0da1',
    ज: '\u0da2',
    झ: '\u0da3',
    ञ: '\u0da4',
    ट: '\u0da7',
    ठ: '\u0da8',
    ड: '\u0da9',
    ढ: '\u0daa',
    ण: '\u0dab',
    त: '\u0dad',
    थ: '\u0dae',
    द: '\u0daf',
    ध: '\u0db0',
    न: '\u0db1',
    ऩ: '\u0db1',
    प: '\u0db4',
    फ: '\u0db5',
    ब: '\u0db6',
    भ: '\u0db7',
    म: '\u0db8',
    य: '\u0dba',
    र: '\u0dbb',
    ल: '\u0dbd',
    ळ: '\u0dc5',
    व: '\u0dc0',
    श: '\u0dc1',
    ष: '\u0dc2',
    स: '\u0dc3',
    ह: '\u0dc4',
    '\u093e': '\u0dcf',
    '\u0949': '\u0dd1',
    '\u093f': '\u0dd2',
    '\u0940': '\u0dd3',
    '\u0941': '\u0dd4',
    '\u0942': '\u0dd6',
    '\u0943': '\u0dd8',
    '\u0946': '\u0dd9',
    '\u0947': '\u0dda',
    '\u0948': '\u0ddb',
    '\u094a': '\u0ddc',
    '\u094b': '\u0ddd',
    '\u094c': '\u0dde',
    '\u094d': '\u0dca'
  }

  /**
   * Transliterate Devanagari text to Sinhala
   * @param {string} text - Input Devanagari text
   * @returns {string} - Transliterated Sinhala text
   */
  static devanagariToSinhala (text) {
    return Array.from(text)
      .map((c) => SinhalaDevanagariTransliterator.devnagSinhalaMap[c] || c)
      .join('')
  }

  /**
   * Transliterate Sinhala text to Devanagari
   * @param {string} text - Input Sinhala text
   * @returns {string} - Transliterated Devanagari text
   */
  static sinhalaToDevanagari (text) {
    return Array.from(text)
      .map((c) => SinhalaDevanagariTransliterator.sinhalaDevnagMap[c] || c)
      .join('')
  }
}

module.exports = {
  SinhalaDevanagariTransliterator
}
