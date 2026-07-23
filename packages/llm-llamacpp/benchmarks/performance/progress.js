'use strict'

const process = require('bare-process')

function createDebugLogger (enabled) {
  return {
    log: (...msgs) => {
      if (enabled) console.log(...msgs)
    },
    warn: (...msgs) => {
      if (enabled) console.warn(...msgs)
    },
    error: (...msgs) => {
      if (enabled) console.error(...msgs)
    }
  }
}

function formatDurationMs (ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) return '?:??:??'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function truncateText (text, maxLen) {
  const value = String(text ?? '')
  if (!Number.isInteger(maxLen) || maxLen <= 0) return ''
  if (value.length <= maxLen) return value
  if (maxLen <= 3) return value.slice(0, maxLen)
  return `${value.slice(0, maxLen - 3)}...`
}

function createProgressReporter (totalRuns) {
  const startTime = Date.now()
  let completedRuns = 0
  let lastNonTtyPercent = -1
  let lastRenderedLength = 0
  const canRewriteLine = !!(process.stdout && typeof process.stdout.write === 'function')
  const barWidth = 24

  function render (context) {
    const percent = totalRuns > 0 ? (completedRuns / totalRuns) * 100 : 100
    const elapsedMs = Date.now() - startTime
    const etaMs = completedRuns > 0
      ? (elapsedMs / completedRuns) * (totalRuns - completedRuns)
      : null

    const modelLabel = context && context.modelId ? truncateText(context.modelId, 24) : 'unknown'
    const caseLabel = context && typeof context.caseIndex === 'number' && typeof context.caseCount === 'number'
      ? `${context.caseIndex}/${context.caseCount}`
      : '?/?'
    const repeatLabel = context && typeof context.repeat === 'number' && typeof context.repeats === 'number'
      ? `${context.repeat}/${context.repeats}`
      : '?/?'
    const etaLabel = etaMs == null ? '--:--:--' : formatDurationMs(etaMs)

    if (!canRewriteLine) {
      const flooredPercent = Math.floor(percent)
      if (flooredPercent === lastNonTtyPercent && completedRuns !== totalRuns) return
      lastNonTtyPercent = flooredPercent
      console.log(
        `[progress] ${completedRuns}/${totalRuns} (${percent.toFixed(1)}%)` +
        ` | model=${modelLabel} case=${caseLabel} repeat=${repeatLabel} | eta=${etaLabel}`
      )
      return
    }

    const filled = Math.round((percent / 100) * barWidth)
    const bar = `${'#'.repeat(filled)}${'-'.repeat(Math.max(0, barWidth - filled))}`
    let line =
      `[progress] [${bar}] ${completedRuns}/${totalRuns} (${percent.toFixed(1)}%)` +
      ` | m=${modelLabel} c=${caseLabel} r=${repeatLabel} eta=${etaLabel}`
    const columns = process.stdout && Number.isInteger(process.stdout.columns) ? process.stdout.columns : null
    if (columns && columns > 0 && line.length >= columns) {
      line = truncateText(line, columns - 1)
    }
    const clearPadding = lastRenderedLength > line.length ? ' '.repeat(lastRenderedLength - line.length) : ''
    process.stdout.write(`\r${line}${clearPadding}`)
    lastRenderedLength = line.length
    if (completedRuns === totalRuns) {
      process.stdout.write('\n')
    }
  }

  return {
    tick (context) {
      completedRuns += 1
      render(context)
    },
    start () {
      render({})
    }
  }
}

module.exports = {
  createDebugLogger,
  formatDurationMs,
  truncateText,
  createProgressReporter
}
