'use strict'

const { countScalars } = require('./textChunker')

/**
 * @param {string} s
 * @param {number} n
 * @returns {{ head: string, rest: string }}
 */
function splitGraphemeHead (s, n) {
  const g = [...s]
  if (g.length <= n) {
    return { head: s, rest: '' }
  }
  return {
    head: g.slice(0, n).join(''),
    rest: g.slice(n).join('')
  }
}

/**
 * @param {{ sentenceDelimiter?: RegExp, sentenceDelimiterPreset?: string }} opts
 * @returns {(buffer: string) => boolean}
 */
function buildSentenceEndTester (opts) {
  if (opts.sentenceDelimiter instanceof RegExp) {
    const re = opts.sentenceDelimiter
    return function testCustom (buffer) {
      re.lastIndex = 0
      return re.test(buffer)
    }
  }
  const preset = opts.sentenceDelimiterPreset || 'multilingual'
  const patterns = {
    latin: /[.!?…]\s*$/u,
    cjk: /[。！？…]\s*$/u,
    multilingual: /(?:[.!?…؟]|[。！？…])\s*$/u
  }
  const re = patterns[preset] || patterns.multilingual
  return function testPreset (buffer) {
    return re.test(buffer)
  }
}

/**
 * Default `maxBufferScalars` aligned with `splitTtsText` when `maxScalars` is unset.
 * @param {string} [language]
 */
function defaultMaxBufferScalars (language) {
  const lang = (language || 'en').toLowerCase()
  return lang === 'ko' ? 120 : 300
}

/**
 * Coalesces small text fragments from a streaming source into TTS-sized strings: flush when the
 * buffer ends with a sentence delimiter, when grapheme length exceeds `maxBufferScalars`, or after
 * `flushAfterMs` idle (timer reset on each fragment). Always flushes non-whitespace remainder when
 * the source ends.
 *
 * @param {AsyncIterable<string>} source
 * @param {object} opts
 * @param {RegExp} [opts.sentenceDelimiter] - If set, overrides `sentenceDelimiterPreset`.
 * @param {'latin'|'cjk'|'multilingual'} [opts.sentenceDelimiterPreset]
 * @param {number} [opts.maxBufferScalars]
 * @param {number} [opts.flushAfterMs]
 * @returns {AsyncGenerator<string, void, void>}
 */
async function * accumulateTextStream (source, opts) {
  const flushAfterMs = opts.flushAfterMs != null ? opts.flushAfterMs : 500
  const defaultMax = defaultMaxBufferScalars(opts.language)
  let maxScalars
  if (opts.maxBufferScalars == null) {
    maxScalars = defaultMax
  } else {
    const n = Number(opts.maxBufferScalars)
    maxScalars = Number.isFinite(n) && n > 0 ? n : defaultMax
  }
  const testEnd = buildSentenceEndTester(opts)

  const queue = []
  let notify = null

  function push (item) {
    queue.push(item)
    if (notify) {
      const n = notify
      notify = null
      n()
    }
  }

  ;(async function pump () {
    let buffer = ''
    let idleTimer = null

    function clearIdle () {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    function armIdle () {
      clearIdle()
      idleTimer = setTimeout(() => {
        idleTimer = null
        const t = buffer.trim()
        if (t) {
          buffer = ''
          push({ kind: 'chunk', text: t })
        }
      }, flushAfterMs)
    }

    try {
      for await (const fragment of source) {
        clearIdle()
        buffer += String(fragment)

        while (countScalars(buffer) >= maxScalars) {
          const { head, rest } = splitGraphemeHead(buffer, maxScalars)
          buffer = rest
          if (head.length > 0) {
            push({ kind: 'chunk', text: head })
          }
        }

        if (testEnd(buffer)) {
          const t = buffer.trim()
          buffer = ''
          if (t) {
            push({ kind: 'chunk', text: t })
          }
        }

        armIdle()
      }

      clearIdle()
      const tail = buffer.trim()
      if (tail) {
        push({ kind: 'chunk', text: tail })
      }
      push({ kind: 'done' })
    } catch (error) {
      clearIdle()
      push({ kind: 'err', error })
    }
  })()

  while (true) {
    while (queue.length === 0) {
      await new Promise(resolve => {
        notify = resolve
      })
    }
    const item = queue.shift()
    if (item.kind === 'done') {
      return
    }
    if (item.kind === 'err') {
      throw item.error
    }
    yield item.text
  }
}

module.exports = {
  accumulateTextStream,
  defaultMaxBufferScalars,
  buildSentenceEndTester,
  splitGraphemeHead
}
