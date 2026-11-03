'use strict'

/**
 * Summarizes the `qvac serve` log of an OpenCode smoke run: requests, tool
 * count, prompt size and TTFT. Report only; it never fails the smoke.
 *
 * Run locally:
 *   node scripts/ci/report-opencode-prompt-surface.cjs <qvac-serve.stdout> <out.md>
 *   node --test scripts/ci/__tests__/report-opencode-prompt-surface.test.cjs
 */

const { describeTools, maxMetric } = require('./verify-openclaw-prompt-surface.cjs')

// `maxMetric` cannot parse the `ms` suffix of `ttft=<n>ms`.
function maxTtftMs (log) {
  let max
  for (const match of String(log).matchAll(/\bttft=(\d+)ms\b/g)) {
    const value = Number(match[1])
    if (max === undefined || value > max) max = value
  }
  return max
}

function countRequests (log) {
  return String(log).match(/\bchat model=/g)?.length ?? 0
}

/**
 * @param {string | undefined} log serve stdout, or undefined when none was captured
 * @returns {{ requests: number, maxTools?: number, promptTokens?: number, ttftMs?: number, report: string }}
 */
function inspectPromptSurface (log) {
  const captured = log !== undefined
  const text = log ?? ''
  const requests = countRequests(text)
  const maxTools = maxMetric(text, 'tools')
  const promptTokens = maxMetric(text, 'prompt')
  const ttftMs = maxTtftMs(text)

  const lines = [
    '',
    '## Prompt surface',
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Chat requests | ${captured ? requests : 'unknown'} |`,
    `| Advertised tools (max observed) | ${describeTools(maxTools, requests > 0)} |`,
    `| Prompt tokens (max observed) | ${promptTokens ?? 'unknown'} |`,
    `| Time to first token (max observed) | ${ttftMs === undefined ? 'unknown' : `${ttftMs} ms`} |`,
    ''
  ]
  if (!captured) {
    lines.push(
      'No `qvac serve` output was captured. The installed `@qvac/opencode-plugin` may predate the `serveBinPath` option.',
      ''
    )
  }
  return { requests, maxTools, promptTokens, ttftMs, report: lines.join('\n') }
}

module.exports = { inspectPromptSurface, maxTtftMs, countRequests }

if (require.main === module) {
  const { readFileSync, writeFileSync } = require('node:fs')
  const [logPath, outPath] = process.argv.slice(2)
  if (!logPath || !outPath) {
    console.error('usage: report-opencode-prompt-surface.cjs <qvac-serve.stdout> <out.md>')
    process.exit(2)
  }

  let log
  try {
    log = readFileSync(logPath, 'utf8')
  } catch {
    console.error(`warning: no serve log at ${logPath}; prompt surface unknown`)
  }

  writeFileSync(outPath, inspectPromptSurface(log).report)
}
