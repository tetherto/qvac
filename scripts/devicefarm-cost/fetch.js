'use strict'

/**
 * AWS Device Farm data access for the cost report.
 *
 * Every AWS call goes through the `aws` CLI via `spawnSync` with an argv
 * array (never a shell-interpolated string), matching the pattern used by
 * the rest of the CI (`schedule-test-run`, `cancel-device-farm-runs`, …)
 * and removing command-injection surface around project names / ARNs.
 *
 * Device Farm is a us-west-2-only service for this account; the region is
 * passed explicitly so the report is independent of ambient AWS_REGION.
 *
 * Prerequisites (the OIDC role used in CI must allow):
 *   - devicefarm:ListProjects
 *   - devicefarm:ListRuns
 */

const { spawnSync } = require('child_process')

const MAX_BUFFER = 64 * 1024 * 1024 // list-runs pages can be large

/** Convert a Device Farm timestamp (ISO string or epoch) to epoch ms. */
function toMs (created) {
  if (created == null) return 0
  if (typeof created === 'number') {
    // Heuristic: seconds vs milliseconds.
    return created < 1e12 ? created * 1000 : created
  }
  const parsed = Date.parse(created)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Run `aws <argv> --output json --region <region>` and parse stdout.
 * Throws on a missing binary or non-zero exit (fail-loud, per DevOps rules).
 *
 * @param {string[]} argv
 * @param {{region: string}} opts
 * @returns {object}
 */
function awsJson (argv, opts) {
  const full = [...argv, '--output', 'json', '--region', opts.region]
  const res = spawnSync('aws', full, {
    encoding: 'utf-8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (res.error) {
    throw new Error(`Failed to spawn 'aws' (is the AWS CLI installed and on PATH?): ${res.error.message}`)
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || '').trim()
    throw new Error(`aws ${argv.join(' ')} exited ${res.status}: ${stderr}`)
  }
  const out = (res.stdout || '').trim()
  if (!out) return {}
  try {
    return JSON.parse(out)
  } catch (err) {
    throw new Error(`Could not parse JSON from 'aws ${argv.join(' ')}': ${err.message}`)
  }
}

/**
 * List every Device Farm project in the account/region (paginated).
 * @param {{region: string}} opts
 * @returns {{arn: string, name: string}[]}
 */
function listProjects (opts) {
  const projects = []
  let nextToken
  do {
    const argv = ['devicefarm', 'list-projects']
    if (nextToken) argv.push('--next-token', nextToken)
    const page = awsJson(argv, opts)
    for (const p of page.projects || []) {
      projects.push({ arn: p.arn, name: p.name })
    }
    nextToken = page.nextToken
  } while (nextToken)
  return projects
}

/**
 * List runs for one project, newest-first, stopping once a page reaches
 * runs older than `stopBeforeMs` (runs are returned most-recent-first, so
 * everything past that point is outside the window and safe to skip).
 *
 * @param {{arn: string, name: string}} project
 * @param {{region: string, stopBeforeMs: number}} opts
 * @returns {object[]} normalised run records
 */
function listRunsForProject (project, opts) {
  const runs = []
  let nextToken
  do {
    const argv = ['devicefarm', 'list-runs', '--arn', project.arn]
    if (nextToken) argv.push('--next-token', nextToken)
    const page = awsJson(argv, opts)
    const pageRuns = page.runs || []

    let oldestInPage = Infinity
    for (const r of pageRuns) {
      const created = toMs(r.created)
      if (created < oldestInPage) oldestInPage = created
      runs.push({
        project: project.name,
        arn: r.arn,
        name: r.name || '',
        created,
        platform: r.platform || '',
        result: r.result || '',
        meteredMinutes: Number(r.deviceMinutes?.metered) || 0,
        totalMinutes: Number(r.deviceMinutes?.total) || 0
      })
    }

    nextToken = page.nextToken
    // Once we've paged back past the window start, older runs can't matter.
    if (oldestInPage < opts.stopBeforeMs) break
  } while (nextToken)
  return runs
}

/**
 * Fetch all runs across all projects created on/after `stopBeforeMs`.
 * Per-project failures are collected (not thrown) so one broken project
 * doesn't sink the whole report; the caller surfaces them as partial data.
 *
 * @param {{region: string, stopBeforeMs: number, projectFilter?: (name:string)=>boolean}} opts
 * @returns {{runs: object[], projects: object[], errors: string[]}}
 */
function fetchAllRuns (opts) {
  const errors = []
  let projects = listProjects(opts)
  if (opts.projectFilter) projects = projects.filter((p) => opts.projectFilter(p.name))

  const runs = []
  for (const project of projects) {
    try {
      runs.push(...listRunsForProject(project, opts))
    } catch (err) {
      errors.push(`${project.name}: ${err.message}`)
    }
  }
  return { runs, projects, errors }
}

module.exports = {
  toMs,
  awsJson,
  listProjects,
  listRunsForProject,
  fetchAllRuns
}
