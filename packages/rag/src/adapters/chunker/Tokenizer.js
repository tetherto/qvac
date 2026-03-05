'use strict'

const encoder = {
  encode (str) {
    const out = []
    for (let i = 0; i < str.length; i++) {
      const code = str.codePointAt(i)
      if (code > 0xFFFF) i++
      if (code <= 0x7F) {
        out.push(code)
      } else if (code <= 0x7FF) {
        out.push(
          0xC0 | (code >> 6),
          0x80 | (code & 0x3F)
        )
      } else if (code <= 0xFFFF) {
        out.push(
          0xE0 | (code >> 12),
          0x80 | ((code >> 6) & 0x3F),
          0x80 | (code & 0x3F)
        )
      } else {
        out.push(
          0xF0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3F),
          0x80 | ((code >> 6) & 0x3F),
          0x80 | (code & 0x3F)
        )
      }
    }
    return new Uint8Array(out)
  }
}

// Encode once and return both length and non-ASCII check
const analyzeUtf8 = (s) => {
  const bytes = encoder.encode(s)
  let hasNonAscii = false
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] > 0x7F) {
      hasNonAscii = true
    }
  }
  return { length: bytes.length, hasNonAscii }
}

const SUPPORTS_UNICODE_PROPS = (() => {
  try {
    // eslint-disable-next-line prefer-regex-literals
    new RegExp('\\p{L}', 'u').test('a')
    return true
  } catch (e) {
    return false
  }
})()

// Use the original pattern but with better weight tuning
const PRETOKEN_RE = SUPPORTS_UNICODE_PROPS
  // eslint-disable-next-line prefer-regex-literals
  ? new RegExp('\'s|\'t|\'re|\'ve|\'m|\'ll|\'d| ?[\\p{L}]+| ?[\\p{N}]+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+', 'gu')
  : /'s|'t|'re|'ve|'m|'ll|'d| ?[A-Za-z]+| ?[0-9]+| ?[^\sA-Za-z0-9]+|\s+(?!\S)|\s+/g

// Cached regex patterns
const WHITESPACE_RE = /^\s+$/
const LETTERS_RE = SUPPORTS_UNICODE_PROPS
  // eslint-disable-next-line prefer-regex-literals
  ? new RegExp('^[\\p{L}]+$', 'u')
  : /^[A-Za-z]+$/
const NUMBERS_RE = SUPPORTS_UNICODE_PROPS
  // eslint-disable-next-line prefer-regex-literals
  ? new RegExp('^[\\p{N}]+$', 'u')
  : /^[0-9]+$/

const isWhitespace = (s) => WHITESPACE_RE.test(s)
const isLetters = (s) => LETTERS_RE.test(s)
const isNumbers = (s) => NUMBERS_RE.test(s)

// Basic URL detection
const isURLish = (s) => {
  if (/^https?:\/\//i.test(s)) return true
  if (s.indexOf('://') !== -1) return true
  if (/\w\.\w/.test(s) && /[/;?#]/.test(s)) return true
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s)) return true
  // Consider encoded URL components
  if (/%[0-9A-F]{2}/i.test(s)) return true
  return false
}

// Check if this looks like markdown syntax
const isMarkdownSyntax = (s) => {
  return /^(\*{1,2}|#{1,6}|\[|\]|\(|\)|-)$/.test(s)
}

// Token estimation weights calibrated for language model compatibility
const DEFAULT_WEIGHTS = {
  lettersDivisor: 4.8, // Most words stay as single tokens
  numbersDivisor: 3.0, // Numbers get moderate splitting
  symbolsDivisor: 1.6, // Symbols split more but not always individual
  whitespaceDivisor: 6.5, // Whitespace tokens
  urlDivisor: 2.8, // URLs split moderately
  markdownDivisor: 1.2, // Markdown syntax usually gets own tokens
  nonAsciiPenalty: 1.05, // Small penalty for non-ASCII
  globalBias: 0.88 // Global adjustment factor
}

function estimateTokenCount (text, weights) {
  const w = { ...DEFAULT_WEIGHTS, ...weights }
  let tokens = 0

  PRETOKEN_RE.lastIndex = 0
  let m

  while ((m = PRETOKEN_RE.exec(text)) !== null) {
    const seg = m[0]
    const core = seg.charAt(0) === ' ' ? seg.slice(1) : seg

    const utf8Info = analyzeUtf8(seg)

    let divisor
    if (isWhitespace(seg)) {
      divisor = w.whitespaceDivisor
    } else if (isMarkdownSyntax(core)) {
      divisor = w.markdownDivisor
    } else if (isURLish(core)) {
      divisor = w.urlDivisor
    } else if (isLetters(core)) {
      // Adjust for word length - shorter words more likely to be single tokens
      const lengthFactor = core.length <= 5 ? 1.2 : core.length <= 10 ? 1.0 : 0.9
      divisor = w.lettersDivisor * lengthFactor
    } else if (isNumbers(core)) {
      divisor = w.numbersDivisor
    } else {
      divisor = w.symbolsDivisor
    }

    let est = Math.ceil(utf8Info.length / divisor)
    if (utf8Info.hasNonAscii) est = Math.ceil(est * w.nonAsciiPenalty)

    tokens += est
  }

  return Math.round(tokens * w.globalBias)
}

function tokenizeText (text, weights) {
  const w = { ...DEFAULT_WEIGHTS, ...weights }
  const tokens = []
  let total = 0

  PRETOKEN_RE.lastIndex = 0
  let m

  while ((m = PRETOKEN_RE.exec(text)) !== null) {
    const seg = m[0]
    const core = seg.charAt(0) === ' ' ? seg.slice(1) : seg

    const utf8Info = analyzeUtf8(seg)

    let divisor
    if (isWhitespace(seg)) {
      divisor = w.whitespaceDivisor
    } else if (isMarkdownSyntax(core)) {
      divisor = w.markdownDivisor
    } else if (isURLish(core)) {
      divisor = w.urlDivisor
    } else if (isLetters(core)) {
      // Adjust for word length - shorter words more likely to be single tokens
      const lengthFactor = core.length <= 5 ? 1.2 : core.length <= 10 ? 1.0 : 0.9
      divisor = w.lettersDivisor * lengthFactor
    } else if (isNumbers(core)) {
      divisor = w.numbersDivisor
    } else {
      divisor = w.symbolsDivisor
    }

    let est = Math.ceil(utf8Info.length / divisor)
    if (utf8Info.hasNonAscii) est = Math.ceil(est * w.nonAsciiPenalty)

    tokens.push({ text: seg, count: est })
    total += est
  }

  total = Math.round(total * w.globalBias)
  return { tokens, total }
}

module.exports = {
  tokenizeText,
  estimateTokenCount
}
