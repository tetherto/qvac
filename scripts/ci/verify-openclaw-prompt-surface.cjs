'use strict'

/**
 * Reports the prompt surface a smoke run drove, and fails when the advertised
 * tool count exceeds the ceiling. The tool count sets the prompt size, which
 * sets the per-turn prefill cost, and upstream changes it between releases --
 * so the smoke pins `tools.profile` and this reports drift past the ceiling.
 *
 * Run locally:
 *   node scripts/ci/verify-openclaw-prompt-surface.cjs <qvac-serve.stdout> <profile> <maxTools> <out.md>
 *   node --test scripts/ci/__tests__/verify-openclaw-prompt-surface.test.cjs
 */

/**
 * `qvac serve` logs `tools=N` per request and `prompt=N` per completion. A run
 * makes several requests and the worst one sets the deadline, so take the max.
 * @returns {number | undefined} undefined when the log carries no such metric
 */
function maxMetric (log, name) {
  const pattern = new RegExp(`\\b${name}=(\\d+)\\b`, 'g')
  let max
  for (const match of String(log).matchAll(pattern)) {
    const value = Number(match[1])
    if (max === undefined || value > max) max = value
  }
  return max
}

function renderReport ({ profile, maxTools, promptTokens, ceiling }) {
  return [
    '',
    '## Prompt surface',
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| \`tools.profile\` | \`${profile}\` |`,
    `| Advertised tools (max observed) | ${maxTools ?? 'unknown'} |`,
    `| Prompt tokens (max observed) | ${promptTokens ?? 'unknown'} |`,
    `| Tool ceiling | ${ceiling} |`,
    ''
  ].join('\n')
}

/**
 * @returns {{ ok: boolean, maxTools?: number, promptTokens?: number, report: string, reason?: string }}
 */
function inspectPromptSurface (log, profile, ceiling) {
  const maxTools = maxMetric(log, 'tools')
  const promptTokens = maxMetric(log, 'prompt')
  const report = renderReport({ profile, maxTools, promptTokens, ceiling })

  // Unmeasured, not bounded: reporting 0 would claim a ceiling was respected
  // when no request was ever logged.
  if (maxTools === undefined) {
    return { ok: true, maxTools, promptTokens, report }
  }
  if (maxTools > ceiling) {
    return {
      ok: false,
      maxTools,
      promptTokens,
      report,
      reason: `OpenClaw advertised ${maxTools} tools under tools.profile=${profile}, above the ${ceiling} ceiling`
    }
  }
  return { ok: true, maxTools, promptTokens, report }
}

module.exports = { inspectPromptSurface, maxMetric, renderReport }

if (require.main === module) {
  const { readFileSync, writeFileSync } = require('node:fs')
  const [logPath, profile, ceilingArg, outPath] = process.argv.slice(2)
  if (!logPath || !profile || !ceilingArg || !outPath) {
    console.error(
      'usage: verify-openclaw-prompt-surface.cjs <qvac-serve.stdout> <profile> <maxTools> <out.md>'
    )
    process.exit(2)
  }

  const ceiling = Number(ceilingArg)
  if (!Number.isInteger(ceiling) || ceiling < 1) {
    console.error(`invalid tool ceiling: ${ceilingArg}`)
    process.exit(2)
  }

  // A missing serve log must not fail the smoke -- it is diagnostic, and the
  // agent verdict is the actual signal.
  let log = ''
  try {
    log = readFileSync(logPath, 'utf8')
  } catch {
    console.error(`warning: no serve log at ${logPath}; prompt surface unknown`)
  }

  const result = inspectPromptSurface(log, profile, ceiling)
  writeFileSync(outPath, result.report)
  if (!result.ok) {
    console.error(result.reason)
    process.exit(1)
  }
}
