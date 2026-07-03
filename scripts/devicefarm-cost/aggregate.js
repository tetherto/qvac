'use strict'

/**
 * Pure aggregation + rendering for the AWS Device Farm cost report
 * (QVAC-21758 — "Baseline & track Device Farm cost").
 *
 * This module has NO side effects at require-time and performs NO I/O:
 * it takes already-fetched, normalised run records and turns them into
 * per-project / per-day rollups and a Markdown report. All AWS access
 * lives in `fetch.js`; all argument parsing / output lives in `report.js`.
 * Keeping the number-crunching isolated here is what makes it unit-testable
 * without touching the network (see `__tests__/aggregate.test.js`).
 *
 * A "normalised run" is:
 *   {
 *     project: string,        // Device Farm project name
 *     arn: string,
 *     name: string,
 *     created: number,        // epoch milliseconds
 *     platform: string,       // 'ANDROID' | 'IOS' | ''
 *     result: string,         // 'PASSED' | 'FAILED' | ...
 *     meteredMinutes: number  // deviceMinutes.metered (the billable figure)
 *   }
 */

// AWS public metered rate. The report's methodology (and the original
// analysis doc) converts metered device-minutes at this flat rate; it is
// overridable via `--rate` so a negotiated/private rate can be modelled.
const RATE_PER_DEVICE_MINUTE = 0.17

function round (n, dp = 2) {
  const f = 10 ** dp
  return Math.round((Number(n) + Number.EPSILON) * f) / f
}

function usd (n) {
  return '$' + round(n, 0).toLocaleString('en-US')
}

function fmtMin (n) {
  return round(n, 1).toLocaleString('en-US')
}

/** UTC calendar day for an epoch-ms timestamp, as 'YYYY-MM-DD'. */
function dayKeyUTC (ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Keep runs whose creation time is within [startMs, endMs). */
function filterRunsByWindow (runs, startMs, endMs) {
  return runs.filter((r) => r.created >= startMs && r.created < endMs)
}

/**
 * Signed percentage change from `prev` to `cur`.
 * Returns null when there is no meaningful baseline (prev <= 0).
 */
function deltaPct (cur, prev) {
  if (!prev || prev <= 0) return null
  return ((cur - prev) / prev) * 100
}

function fmtDelta (cur, prev) {
  const d = deltaPct(cur, prev)
  if (d === null) return cur > 0 ? 'new' : '—'
  const sign = d > 0 ? '+' : ''
  return `${sign}${round(d, 1)}%`
}

/**
 * Roll a list of normalised runs up into totals + per-project + per-day.
 *
 * @param {object[]} runs
 * @param {{rate?: number}} [opts]
 */
function aggregate (runs, opts = {}) {
  const rate = opts.rate ?? RATE_PER_DEVICE_MINUTE

  let meteredMinutes = 0
  const byProject = new Map()
  const byDay = new Map()

  for (const r of runs) {
    const m = Number(r.meteredMinutes) || 0
    meteredMinutes += m

    const p = byProject.get(r.project) || {
      project: r.project,
      meteredMinutes: 0,
      runCount: 0
    }
    p.meteredMinutes += m
    p.runCount += 1
    byProject.set(r.project, p)

    const key = dayKeyUTC(r.created)
    const d = byDay.get(key) || { date: key, meteredMinutes: 0, runCount: 0 }
    d.meteredMinutes += m
    d.runCount += 1
    byDay.set(key, d)
  }

  const perProject = [...byProject.values()]
    .map((p) => ({
      ...p,
      cost: round(p.meteredMinutes * rate),
      sharePct: meteredMinutes > 0 ? round((p.meteredMinutes / meteredMinutes) * 100, 2) : 0
    }))
    .sort((a, b) => b.meteredMinutes - a.meteredMinutes)

  const perDay = [...byDay.values()]
    .map((d) => ({ ...d, cost: round(d.meteredMinutes * rate) }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    runCount: runs.length,
    meteredMinutes: round(meteredMinutes, 1),
    cost: round(meteredMinutes * rate),
    perProject,
    perDay
  }
}

function windowLabel (win) {
  // Windows are half-open [start, end); show the inclusive last day.
  const startDay = dayKeyUTC(win.startMs)
  const endDay = dayKeyUTC(win.endMs - 1)
  return startDay === endDay ? startDay : `${startDay} → ${endDay}`
}

/**
 * Render the full Markdown report (GitHub-flavoured, Step-Summary friendly).
 *
 * @param {{
 *   current: object,                // aggregate() result
 *   previous?: object|null,         // aggregate() result for the prior window
 *   currentWindow: {startMs:number,endMs:number},
 *   previousWindow?: {startMs:number,endMs:number}|null,
 *   rate: number,
 *   generatedAt?: number,
 *   errors?: string[]
 * }} args
 */
function renderMarkdown (args) {
  const {
    current,
    previous = null,
    currentWindow,
    previousWindow = null,
    rate,
    generatedAt = Date.now(),
    errors = []
  } = args

  const prevByProject = new Map((previous?.perProject || []).map((p) => [p.project, p]))
  const lines = []

  lines.push('# AWS Device Farm — Cost Report')
  lines.push('')
  lines.push(`Window: **${windowLabel(currentWindow)}** (UTC) · rate **$${rate}/device-min** · generated ${new Date(generatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
  lines.push('')

  // KPI line with week-over-week deltas when a baseline is present.
  if (previous) {
    lines.push('| Metric | This window | Previous | Δ |')
    lines.push('|---|--:|--:|--:|')
    lines.push(`| Metered device-minutes | ${fmtMin(current.meteredMinutes)} | ${fmtMin(previous.meteredMinutes)} | ${fmtDelta(current.meteredMinutes, previous.meteredMinutes)} |`)
    lines.push(`| Estimated cost | ${usd(current.cost)} | ${usd(previous.cost)} | ${fmtDelta(current.cost, previous.cost)} |`)
    lines.push(`| Billable runs | ${current.runCount.toLocaleString('en-US')} | ${previous.runCount.toLocaleString('en-US')} | ${fmtDelta(current.runCount, previous.runCount)} |`)
  } else {
    lines.push('| Metric | This window |')
    lines.push('|---|--:|')
    lines.push(`| Metered device-minutes | ${fmtMin(current.meteredMinutes)} |`)
    lines.push(`| Estimated cost | ${usd(current.cost)} |`)
    lines.push(`| Billable runs | ${current.runCount.toLocaleString('en-US')} |`)
  }
  lines.push('')

  // Per-project attribution (the actionable table).
  lines.push('## By project')
  lines.push('')
  if (previous) {
    lines.push('| Project | Metered min | Est. $ | Share | Prev $ | Δ |')
    lines.push('|---|--:|--:|--:|--:|--:|')
    for (const p of current.perProject) {
      const prev = prevByProject.get(p.project)
      const prevCost = prev ? usd(prev.cost) : '—'
      const delta = prev ? fmtDelta(p.cost, prev.cost) : 'new'
      lines.push(`| ${p.project} | ${fmtMin(p.meteredMinutes)} | ${usd(p.cost)} | ${p.sharePct}% | ${prevCost} | ${delta} |`)
    }
  } else {
    lines.push('| Project | Metered min | Est. $ | Share |')
    lines.push('|---|--:|--:|--:|')
    for (const p of current.perProject) {
      lines.push(`| ${p.project} | ${fmtMin(p.meteredMinutes)} | ${usd(p.cost)} | ${p.sharePct}% |`)
    }
  }
  if (current.perProject.length === 0) lines.push('| _(no billable runs in window)_ | | | |')
  lines.push('')

  // Daily trend so a spike is obvious at a glance.
  lines.push('## By day (UTC)')
  lines.push('')
  lines.push('| Day | Metered min | Est. $ | Runs |')
  lines.push('|---|--:|--:|--:|')
  for (const d of current.perDay) {
    lines.push(`| ${d.date} | ${fmtMin(d.meteredMinutes)} | ${usd(d.cost)} | ${d.runCount} |`)
  }
  if (current.perDay.length === 0) lines.push('| _(none)_ | | | |')
  lines.push('')

  if (previousWindow) {
    lines.push(`<sub>Previous window for comparison: ${windowLabel(previousWindow)} (UTC).</sub>`)
    lines.push('')
  }
  if (errors.length > 0) {
    lines.push('## ⚠️ Partial data')
    lines.push('')
    lines.push('Some projects could not be fully read; figures above may undercount:')
    for (const e of errors) lines.push(`- ${e}`)
    lines.push('')
  }

  return lines.join('\n')
}

module.exports = {
  RATE_PER_DEVICE_MINUTE,
  round,
  usd,
  fmtMin,
  dayKeyUTC,
  filterRunsByWindow,
  deltaPct,
  fmtDelta,
  aggregate,
  windowLabel,
  renderMarkdown
}
