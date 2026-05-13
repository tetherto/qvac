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

// Detokenizer patterns
const leftAttach = '!%)]},.:;>?\u0964\u0965'
const patLa = new RegExp('[ ]([' + leftAttach + '])', 'g')

const rightAttach = '#$([{<@'
const patRa = new RegExp('([' + rightAttach + '])[ ]', 'g')

const lrAttach = '-/\\\\'
const patLra = new RegExp('[ ]([' + lrAttach + '])[ ]', 'g')

// Date, numbers, section/article numbering
const patNumSeq = /([0-9]+ [,.:/] )+[0-9]+/g

/**
 * Detokenize string for Indian language scripts using Brahmi-derived scripts
 *
 * @param {string} text - tokenized text to process
 * @returns {string} - detokenized string
 */
function trivialDetokenizeIndic (text) {
  let s = text

  // Some normalizations

  // Numbers and dates
  let newS = ''
  let prev = 0

  // Create an array to store all matches
  const matches = Array.from(s.matchAll(patNumSeq))

  // Process each match
  for (const m of matches) {
    const start = m.index
    const end = start + m[0].length

    if (start > prev) {
      newS += s.substring(prev, start)
      newS += s.substring(start, end).replace(/ /g, '')
      prev = end
    }
  }

  // Add remaining text
  newS += s.substring(prev)
  s = newS

  // Handle punctuation attachment - make sure to reset regexes
  patLra.lastIndex = 0
  patLa.lastIndex = 0
  patRa.lastIndex = 0

  // Apply each pattern multiple times to ensure all matches are handled
  while (patLra.test(s)) {
    patLra.lastIndex = 0 // Reset the regex index
    s = s.replace(patLra, '$1')
  }

  while (patLa.test(s)) {
    patLa.lastIndex = 0
    s = s.replace(patLa, '$1')
  }

  while (patRa.test(s)) {
    patRa.lastIndex = 0
    s = s.replace(patRa, '$1')
  }

  // Handle quotes
  const altAttach = '\'"`'

  for (const punc of altAttach) {
    // Count the occurrences to alternate between right and left attach
    let cnt = 0
    const outStr = []

    for (const c of s) {
      if (c === punc) {
        if (cnt % 2 === 0) {
          outStr.push('@RA')
        } else {
          outStr.push('@LA')
        }
        cnt++
      } else {
        outStr.push(c)
      }
    }

    // Process replacements
    s = outStr.join('')

    // Process each replacement separately to ensure all matches are handled
    s = s.replace(/@RA /g, punc)
    s = s.replace(/ @LA/g, punc)
    s = s.replace(/@RA/g, punc)
    s = s.replace(/@LA/g, punc)
  }

  // Additional cleanup to handle specific issues seen in the output

  // Fix spaces before punctuation (including danda and semicolon)
  s = s.replace(/ ([।.,:;!?])/g, '$1')

  // Fix spaces inside parentheses
  s = s.replace(/\( /g, '(')
  s = s.replace(/ \)/g, ')')

  // Fix quote escaping
  s = s.replace(/\\'/g, "'")

  return s
}

/**
 * Detokenize string for languages of the Indian subcontinent
 *
 * @param {string} text - tokenized text to process
 * @param {string} lang - language code (default: 'hi')
 * @returns {string} - detokenized string
 */
function trivialDetokenize (text, lang = 'hi') {
  return trivialDetokenizeIndic(text)
}

module.exports = {
  trivialDetokenizeIndic,
  trivialDetokenize
}
