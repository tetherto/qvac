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
const sdt = require('./sinhala_transliterator').SinhalaDevanagariTransliterator

/**
 * Base class for rule-based transliteration among Indian languages.
 *
 * Script pair specific transliterators should derive from this class and override the transliterate() method.
 * They can call the super class 'transliterate()' method to avail of the common transliteration.
 */
class UnicodeIndicTransliterator {
  /**
   * Handle missing unaspirated and voiced plosives in Tamil script
   * Replace by unvoiced, unaspirated plosives
   * @param {number} offset - Character offset
   * @returns {number} - Corrected offset
   * @private
   */
  static _correctTamilMapping (offset) {
    // For first 4 consonant rows of varnamala
    // Exception: ja has a mapping in Tamil
    if (
      offset >= 0x15 &&
      offset <= 0x28 &&
      offset !== 0x1c &&
      !((offset - 0x15) % 5 === 0 || (offset - 0x15) % 5 === 4)
    ) {
      const substChar = Math.floor((offset - 0x15) / 5)
      offset = 0x15 + 5 * substChar
    }

    // For 5th consonant row of varnamala
    if (offset === 0x2b || offset === 0x2c || offset === 0x2d) {
      offset = 0x2a
    }

    // 'sh' becomes 'Sh'
    if (offset === 0x36) {
      offset = 0x37
    }

    return offset
  }

  /**
   * Convert the source language script (lang1) to target language script (lang2)
   * @param {string} text - Text to transliterate
   * @param {string} lang1Code - Source language code
   * @param {string} lang2Code - Target language code
   * @returns {string} - Transliterated text
   */
  static transliterate (text, lang1Code, lang2Code) {
    if (
      lang1Code in langinfo.SCRIPT_RANGES &&
      lang2Code in langinfo.SCRIPT_RANGES
    ) {
      // If Sinhala is source, do a mapping to Devanagari first
      if (lang1Code === 'si') {
        text = sdt.sinhalaToDevanagari(text)
        lang1Code = 'hi'
      }

      // If Sinhala is target, make Devanagari the intermediate target
      let orgLang2Code = ''
      if (lang2Code === 'si') {
        orgLang2Code = 'si'
        lang2Code = 'hi'
      }

      const transLitText = []
      for (const c of text) {
        let newc = c
        const offset = c.charCodeAt(0) - langinfo.SCRIPT_RANGES[lang1Code][0]

        if (
          offset >= langinfo.COORDINATED_RANGE_START_INCLUSIVE &&
          offset <= langinfo.COORDINATED_RANGE_END_INCLUSIVE &&
          c !== '\u0964' &&
          c !== '\u0965'
        ) {
          let correctedOffset = offset
          if (lang2Code === 'ta') {
            // Tamil exceptions
            correctedOffset =
              UnicodeIndicTransliterator._correctTamilMapping(offset)
          }

          newc = String.fromCharCode(
            langinfo.SCRIPT_RANGES[lang2Code][0] + correctedOffset
          )
        }

        transLitText.push(newc)
      }

      // If Sinhala is target, convert from Devanagari
      if (orgLang2Code === 'si') {
        return sdt.devanagariToSinhala(transLitText.join(''))
      }
      return transLitText.join('')
    } else {
      return text
    }
  }
}

module.exports = {
  UnicodeIndicTransliterator
}
