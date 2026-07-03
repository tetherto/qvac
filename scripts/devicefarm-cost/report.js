#!/usr/bin/env node
'use strict'

/**
 * AWS Device Farm cost report (QVAC-21758).
 *
 * Fetches metered device-minutes per project from Device Farm, attributes
 * cost at the AWS metered rate, and prints a Markdown report comparing the
 * current window against the immediately-preceding one (week-over-week by
 * default). Intended to run weekly (Mondays) in CI and ad-hoc locally so we
 * can see whether the CI cost optimisations actually moved the number.
 *
 * Usage:
 *   node scripts/devicefarm-cost/report.js [options]
 *
 * Options:
 *   --days N            Window length in days (default 7). Ignored if --since is set.
 *   --since YYYY-MM-DD  Window start (UTC midnight, inclusive).
 *   --until YYYY-MM-DD  Window end   (UTC midnight, exclusive). Default: now.
 *   --rate R            $ per metered device-minute (default 0.17).
 *   --no-compare        Do not compute the previous-window baseline.
 *   --project NAME      Only include projects whose name contains NAME
 *                       (case-insensitive, repeatable).
 *   --region R          AWS region (default $AWS_REGION or us-west-2).
 *   --json PATH         Also write the raw rollup as JSON to PATH.
 *   --summary           Append the Markdown to $GITHUB_STEP_SUMMARY.
 *   --help              Show this help.
 *
 * Requires the AWS CLI on PATH with credentials allowing
 * devicefarm:ListProjects + devicefarm:ListRuns (see fetch.js).
 */

const fs = require('fs')
const { aggregate, filterRunsByWindow, renderMarkdown, RATE_PER_DEVICE_MINUTE } = require('./aggregate')
const { fetchAllRuns } = require('./fetch')

const DAY_MS = 24 * 60 * 60 * 1000

function parseArgs (argv) {
  const opts = {
    days: 7,
    since: null,
    until: null,
    rate: RATE_PER_DEVICE_MINUTE,
    compare: true,
    projects: [],
    region: process.env.AWS_REGION || 'us-west-2',
    json: null,
    summary: false,
    help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--days':
        opts.days = Number(argv[++i])
        break
      case '--since':
        opts.since = argv[++i]
        break
      case '--until':
        opts.until = argv[++i]
        break
      case '--rate':
        opts.rate = Number(argv[++i])
        break
      case '--no-compare':
        opts.compare = false
        break
      case '--project':
        opts.projects.push(argv[++i])
        break
      case '--region':
        opts.region = argv[++i]
        break
      case '--json':
        opts.json = argv[++i]
        break
      case '--summary':
        opts.summary = true
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        throw new Error(`Unknown argument: ${a}`)
    }
  }
  return opts
}

/** Parse a YYYY-MM-DD (UTC midnight) into epoch ms; throw on garbage. */
function parseDay (s, label) {
  const ms = Date.parse(`${s}T00:00:00.000Z`)
  if (Number.isNaN(ms)) throw new Error(`Invalid ${label} date: ${s} (expected YYYY-MM-DD)`)
  return ms
}

/**
 * Resolve the current + previous half-open windows from the options.
 * @returns {{current:{startMs,endMs}, previous:{startMs,endMs}|null}}
 */
function computeWindows (opts, now = Date.now()) {
  const endMs = opts.until ? parseDay(opts.until, 'until') : now
  let startMs
  if (opts.since) {
    startMs = parseDay(opts.since, 'since')
  } else {
    if (!(opts.days > 0)) throw new Error(`--days must be a positive number (got ${opts.days})`)
    startMs = endMs - opts.days * DAY_MS
  }
  if (startMs >= endMs) throw new Error('Window start must be before window end')

  const len = endMs - startMs
  const previous = opts.compare ? { startMs: startMs - len, endMs: startMs } : null
  return { current: { startMs, endMs }, previous }
}

function makeProjectFilter (names) {
  if (!names || names.length === 0) return null
  const lowered = names.map((n) => n.toLowerCase())
  return (name) => lowered.some((n) => name.toLowerCase().includes(n))
}

const HELP = `AWS Device Farm cost report

Usage: node scripts/devicefarm-cost/report.js [options]

  --days N            Window length in days (default 7). Ignored if --since is set.
  --since YYYY-MM-DD   Window start (UTC midnight, inclusive).
  --until YYYY-MM-DD   Window end   (UTC midnight, exclusive). Default: now.
  --rate R             $ per metered device-minute (default 0.17).
  --no-compare         Do not compute the previous-window baseline.
  --project NAME       Only include projects whose name contains NAME (repeatable).
  --region R           AWS region (default $AWS_REGION or us-west-2).
  --json PATH          Also write the raw rollup as JSON to PATH.
  --summary            Append the Markdown to $GITHUB_STEP_SUMMARY.
  --help               Show this help.
`

function main () {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    return
  }
  if (!(opts.rate >= 0)) throw new Error(`--rate must be >= 0 (got ${opts.rate})`)

  const now = Date.now()
  const { current, previous } = computeWindows(opts, now)
  const stopBeforeMs = (previous || current).startMs

  const { runs, projects, errors } = fetchAllRuns({
    region: opts.region,
    stopBeforeMs,
    projectFilter: makeProjectFilter(opts.projects)
  })

  const currentAgg = aggregate(filterRunsByWindow(runs, current.startMs, current.endMs), { rate: opts.rate })
  const previousAgg = previous
    ? aggregate(filterRunsByWindow(runs, previous.startMs, previous.endMs), { rate: opts.rate })
    : null

  const md = renderMarkdown({
    current: currentAgg,
    previous: previousAgg,
    currentWindow: current,
    previousWindow: previous,
    rate: opts.rate,
    generatedAt: now,
    errors
  })

  process.stdout.write(md + '\n')

  if (opts.json) {
    const payload = {
      generatedAt: new Date(now).toISOString(),
      rate: opts.rate,
      region: opts.region,
      projectCount: projects.length,
      currentWindow: { start: new Date(current.startMs).toISOString(), end: new Date(current.endMs).toISOString() },
      previousWindow: previous
        ? { start: new Date(previous.startMs).toISOString(), end: new Date(previous.endMs).toISOString() }
        : null,
      current: currentAgg,
      previous: previousAgg,
      errors
    }
    fs.writeFileSync(opts.json, JSON.stringify(payload, null, 2) + '\n')
    process.stderr.write(`Wrote JSON rollup to ${opts.json}\n`)
  }

  if (opts.summary && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
  }

  // Surface partial-data as a non-zero exit so a scheduled run is visibly
  // yellow/red rather than silently under-reporting cost.
  if (errors.length > 0) {
    process.exitCode = 1
    process.stderr.write(`\nCompleted with ${errors.length} project error(s); cost figures may undercount.\n`)
  }
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exit(2)
  }
}

module.exports = { parseArgs, parseDay, computeWindows, makeProjectFilter }
