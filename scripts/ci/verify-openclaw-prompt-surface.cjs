'use strict'

/**
 * Reports the prompt surface a smoke run actually drove, and fails when the
 * advertised tool count exceeds the ceiling.
 *
 * The numbers behind tetherto/qvac#4112 were only ever in the raw artifact:
 * 35 advertised tools inflated the prompt to ~11.3k tokens, which cost ~190s
 * per turn to prefill on a 2-core runner, which is why three turns could not
 * fit any deadline. Nothing reported that, so five consecutive failures read
 * as "agent timed out" with no cause attached.
 *
 * The count is upstream's to change -- openclaw 2026.9.2 advertised 35 and
 * 2026.9.3 advertised 12 with no QVAC-side change -- so the smoke pins
 * `tools.profile` and this check reports drift past the ceiling as a failure
 * rather than as a slower pass.
 *
 * Run locally:
 *   node scripts/ci/verify-openclaw-prompt-surface.cjs <qvac-serve.stdout> <profile> <maxTools> <out.md>
 *   node --test scripts/ci/__tests__/verify-openclaw-prompt-surface.test.cjs
 */

/**
 * `qvac serve` logs one `chat ... tools=N ...` line per request and one
 * `streaming done ... prompt=N ...` line per completion. A run makes several
 * requests and the worst one sets the deadline, so take the maximum.
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

  // An absent count is not a pass and not a failure: the wrapper may simply
  // never have written a log (a skipped agent turn, or a serve that died
  // before its first request). Reporting it as 0 would claim a bounded surface
  // that was never measured.
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
