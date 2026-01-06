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

// Define the punctuation characters
const punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

// Tokenizer patterns
// eslint-disable-next-line no-misleading-character-class
const trivTokenizerIndicPat = new RegExp('([' + punctuation + '\u0964\u0965\uAAF1\uAAF0\uABEB\uABEC\uABED\uABEE\uABEF\u1C7E\u1C7F' + '])', 'g')

const trivTokenizerUrduPat = new RegExp(
  '([' +
    punctuation +
    '\u0609\u060A\u060C\u061E\u066A\u066B\u066C\u066D\u06D4' +
    '])',
  'g'
)

// Date, numbers, section/article numbering
const patNumSeq = /([0-9]+ [,.:/] )+[0-9]+/g

/**
 * Tokenize string for Indian language scripts using Brahmi-derived scripts
 *
 * A trivial tokenizer which just tokenizes on the punctuation boundaries.
 * This also includes punctuations for the Indian language scripts (the
 * purna virama and the deergha virama). This is a language independent
 * tokenizer.
 *
 * @param {string} text - text to tokenize
 * @returns {Array<string>} - list of tokens
 */
function trivialTokenizeIndic (text) {
  // Replace punctuation with space + punctuation + space
  const tokStr = text.replace(/\t/g, ' ').replace(trivTokenizerIndicPat, ' $1 ')

  // Replace multiple spaces with a single space and trim
  let s = tokStr.replace(/\s+/g, ' ').trim()

  // Do not tokenize numbers and dates
  let newS = ''
  let prev = 0

  // Find all number sequences and keep them together
  const matches = s.matchAll(patNumSeq)
  for (const m of matches) {
    const start = m.index
    const end = start + m[0].length

    if (start > prev) {
      newS += s.substring(prev, start)
      newS += s.substring(start, end).replace(/ /g, '')
      prev = end
    }
  }

  newS += s.substring(prev)
  s = newS

  // Split the string on spaces to get tokens
  return s.split(' ').filter((token) => token.length > 0)
}

/**
 * Tokenize Urdu string
 *
 * A trivial tokenizer which just tokenizes on the punctuation boundaries.
 * This also includes punctuations for the Urdu script.
 * These punctuations characters were identified from the Unicode database
 * for Arabic script by looking for punctuation symbols.
 *
 * @param {string} text - text to tokenize
 * @returns {Array<string>} - list of tokens
 */
function trivialTokenizeUrdu (text) {
  // Replace punctuation with space + punctuation + space
  const tokStr = text.replace(/\t/g, ' ').replace(trivTokenizerUrduPat, ' $1 ')

  // Replace multiple spaces with a single space, trim, and split
  return tokStr
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0)

  // Note: The Python version had a commented-out section for urduhack.
  // If an equivalent JavaScript library exists, it could be used instead.
}

/**
 * Trivial tokenizer for Indian languages using Brahmi or Arabic scripts
 *
 * A trivial tokenizer which just tokenizes on the punctuation boundaries.
 * Major punctuations specific to Indian languages are handled.
 * These punctuations characters were identified from the Unicode database.
 *
 * @param {string} text - text to tokenize
 * @param {string} lang - ISO 639-2 language code (default: 'hi')
 * @returns {Array<string>} - list of tokens
 */
function trivialTokenize (text, lang = 'hi') {
  if (lang === 'ur') {
    return trivialTokenizeUrdu(text)
  } else {
    return trivialTokenizeIndic(text)
  }
}

// Export the functions
module.exports = {
  trivialTokenizeIndic,
  trivialTokenizeUrdu,
  trivialTokenize
}
