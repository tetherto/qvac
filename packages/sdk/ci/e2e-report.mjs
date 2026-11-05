#!/usr/bin/env node
// The SDK pod's e2e router and report, main's sdk-e2e-* actions in one place. plan reads the run's label (base on
// test-e2e-smoke or test-e2e-full, probe on test-e2e-python, rerun on test-e2e-rerun-failed), picks each leg's rows and
// posts the running comments; report fills them in, records a base run's failures, checks a rerun and labels e2e-tested.
//   node ci/e2e-report.mjs plan|report

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { SAFE_LIST, encodeOptions, list } from './e2e.mjs'

const SDK = '@qvac/sdk'
const STATE = '<!-- sdk-e2e-base-state -->'
const STATE_DATA = /<!-- sdk-e2e-base-state-data:v2:([A-Za-z0-9+/=]+) -->/
const PLAN = '<!-- sdk-e2e-rerun-plan -->'
const RERUN = 'test-e2e-rerun-failed'
const MAX_TESTS = 400
export const MODES = {
  'test-e2e-smoke': 'base',
  'test-e2e-full': 'base',
  'test-e2e-python': 'probe',
  [RERUN]: 'rerun'
}

export const keyOf = (row) => `${row.slug}/${row.config}`
// The rows whose legs write results-*.json: the SDK's own e2e and its Device Farm app.
export const reported = (row) => row.project === SDK

function github(env) {
  const api = env.GITHUB_API_URL || 'https://api.github.com'
  const call = async (method, path, body) => {
    const url = path.startsWith('/')
      ? `${api}${path}`
      : `${api}/repos/${env.GITHUB_REPOSITORY}/${path}`
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: body ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      const err = new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
      err.status = res.status
      throw err
    }
    return res.status === 204 ? null : res.json()
  }
  const all = async (path, key) => {
    const out = []
    for (let page = 1; ; page++) {
      const data = await call(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`
      )
      const items = key ? data[key] : data
      out.push(...items)
      if (items.length < 100) return out
    }
  }
  return { call, all }
}

const output = (env, values) => {
  if (!env.GITHUB_OUTPUT) return console.log(values)
  for (const [k, v] of Object.entries(values)) {
    appendFileSync(env.GITHUB_OUTPUT, `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}\n`)
  }
}
const summary = (env, text) =>
  env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n\n`)
const runUrlOf = (env) =>
  `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
const fmt = (v) => (v ? `\`${v}\`` : '`(none)`')
const marker = (pr, key) => `<!-- sdk-e2e-report:pr=${pr}:row=${key} -->`
const describe = (run) =>
  `${run.runUrl ? `[run ${run.runId}](${run.runUrl})` : `run ${run.runId}`} · suite \`${run.suite || 'full'}\`` +
  (run.sha ? ` · sha \`${String(run.sha).slice(0, 7)}\`` : '')

// The hidden comment holding the last base run's failures per row, and the base run in flight, if any.
async function readState(gh, pr) {
  const comments = await gh.all(`issues/${pr}/comments`)
  const comment = comments.filter((c) => (c.body || '').includes(STATE)).pop() ?? null
  let state = { recorded: null, running: null }
  if (comment && STATE_DATA.test(comment.body)) {
    try {
      state = JSON.parse(Buffer.from(STATE_DATA.exec(comment.body)[1], 'base64').toString('utf8'))
    } catch (err) {
      console.log(`::warning::Ignoring undecodable base state: ${err.message}`)
    }
  }
  return { comments, comment, state }
}

async function writeState(gh, pr, existing, state) {
  const lines = [STATE]
  if (state.running) {
    lines.push(
      '### QVAC E2E — base run in progress',
      `**Running:** ${describe(state.running)}`,
      '',
      `The \`${RERUN}\` label is rejected until this run finishes and its failure set is recorded below.`
    )
    if (state.recorded) lines.push('', '---', '')
  }
  if (state.recorded) {
    const failed = state.recorded.rows.reduce((n, r) => n + r.failed.length, 0)
    lines.push(
      '### QVAC E2E — base run recorded',
      `**Base:** ${describe(state.recorded)}`,
      '',
      '| Leg | Passed | Total | Failed |',
      '| --- | --- | --- | --- |',
      ...state.recorded.rows.map(
        (r) => `| \`${r.key}\` | ${r.passed} | ${r.total} | ${r.failed.length} |`
      ),
      '',
      failed === 0
        ? `All recorded legs are green — nothing for \`${RERUN}\` to re-run.`
        : `Apply **\`${RERUN}\`** to re-run just these ${failed} failing test(s) against the current head commit. ` +
            'The label clears itself, so add it again for each attempt; every attempt re-runs this same set until a ' +
            'new `test-e2e-smoke` / `test-e2e-full` run replaces this base.'
    )
    if (state.recorded.truncated) {
      lines.push(
        '',
        `> Only the first ${MAX_TESTS} failing test ids were recorded. Re-run the full suite instead.`
      )
    }
  }
  // Base64 keeps arbitrary test ids from closing the HTML comment early.
  const data = Buffer.from(JSON.stringify(state), 'utf8').toString('base64')
  lines.push('', `<!-- sdk-e2e-base-state-data:v2:${data} -->`)
  const body = lines.join('\n')
  if (existing) await gh.call('PATCH', `issues/comments/${existing.id}`, { body })
  else await gh.call('POST', `issues/${pr}/comments`, { body })
}

async function upsert(gh, pr, comments, mark, body) {
  const existing = comments.filter((c) => (c.body || '').includes(mark)).pop()
  if (existing) {
    await gh.call('PATCH', `issues/comments/${existing.id}`, { body: `${mark}\n${body}` })
  } else {
    await gh.call('POST', `issues/${pr}/comments`, { body: `${mark}\n${body}` })
  }
}

// main's report-start: one running comment per leg, the earlier run's comment for that leg minimized.
async function postRunning(gh, env, pr, rows, configLine) {
  const query = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
      comments(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id isMinimized body } } } } }`
  const [owner, repo] = env.GITHUB_REPOSITORY.split('/')
  const existing = []
  for (let cursor = null; ;) {
    const page = await gh.call('POST', '/graphql', {
      query,
      variables: { owner, repo, number: pr, cursor }
    })
    const conn = page.data.repository.pullRequest.comments
    existing.push(...conn.nodes)
    if (!conn.pageInfo.hasNextPage) break
    cursor = conn.pageInfo.endCursor
  }
  const ids = {}
  for (const row of rows) {
    const mark = marker(pr, keyOf(row))
    for (const prior of existing.filter((c) => (c.body || '').includes(mark) && !c.isMinimized)) {
      const minimize = `mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) {
        minimizedComment { isMinimized } } }`
      await gh
        .call('POST', '/graphql', { query: minimize, variables: { id: prior.id } })
        .catch((err) => {
          console.log(
            `::warning::Could not minimize the earlier comment for ${keyOf(row)}: ${err.message}`
          )
        })
    }
    const body = [
      mark,
      `### QVAC E2E — \`${keyOf(row)}\` — running`,
      `[View run](${runUrlOf(env)})`,
      configLine
    ]
    const created = await gh.call('POST', `issues/${pr}/comments`, { body: body.join('\n') })
    ids[keyOf(row)] = created.id
  }
  return ids
}

async function isRunInFlight(gh, runId) {
  try {
    return (await gh.call('GET', `actions/runs/${runId}`)).status !== 'completed'
  } catch (err) {
    if (err.status === 404) return false
    throw err
  }
}

// main's sdk-e2e-report-impacted: the impact mapper ran PR code, so every field is checked before it is rendered.
const IMPACTED = '<!-- sdk-e2e-impacted -->'
const E2E_PREFIX = 'packages/sdk-e2e/'
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/
const SAFE_ID = /^[A-Za-z0-9._-]+$/
const VIA = new Set([
  'definitions (whole file)',
  'definitions (changed lines)',
  'executor pattern',
  'import graph',
  'inference engine',
  'sdk handler',
  'sdk api'
])

// The validated ids to add, and the comment to post (null for none).
export function impacted({ result, include, json }) {
  const ok = result === 'success' && (!include || SAFE_LIST.test(include))
  if (result === 'success' && !ok) {
    console.log(
      '::error title=Unsafe test ids::The impact mapper emitted ids outside [A-Za-z0-9._-]'
    )
  }
  let report = null
  try {
    report = ok && json ? JSON.parse(json) : null
  } catch (err) {
    console.log(`::warning::Impact report could not be parsed: ${err.message}`)
  }
  if (!report || typeof report !== 'object') {
    return {
      include: '',
      body:
        '### QVAC E2E — impact analysis unavailable\n\n' +
        '⚠️ The impact mapper did not produce a report, so this is a plain smoke run: tests this PR added or ' +
        'changed may not have run. Check the `impacted` job, or apply `test-e2e-full`.'
    }
  }
  const count = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const strip = (f) => (f.startsWith(E2E_PREFIX) ? f.slice(E2E_PREFIX.length) : f)
  const paths = (v) =>
    (Array.isArray(v) ? v : []).filter((f) => typeof f === 'string' && SAFE_PATH.test(f)).map(strip)
  const ids = (v) =>
    (Array.isArray(v) ? v : []).filter((id) => typeof id === 'string' && SAFE_ID.test(id))
  if (count(report.changedFilesInScope) === 0) return { include, body: null }
  const affected = count(report.affected?.length)
  const covered = count(report.coveredBySmoke?.length)
  const added = ids(report.includeTests)
  const unmapped = paths(report.unmapped)
  const rejected = count(report.rejectedIds?.length)
  const lines = ['### QVAC E2E — tests changed by this PR', '']
  if (added.length) {
    lines.push(
      `This smoke run additionally covers **${added.length}** test(s) that are not tagged \`smoke\`, adding ` +
        `roughly **${count(report.addedMinutes)} min**.`
    )
  } else if (affected)
    lines.push('Every test this PR touched is already covered by the smoke suite.')
  else lines.push('No test could be attributed to the changed files listed below.')
  lines.push(
    '',
    `**Catalog:** ${count(report.catalog)} tests · **smoke:** ${count(report.smoke)} · ` +
      `**touched by this PR:** ${affected} (${covered} already in smoke)`,
    ''
  )
  const attribution = (Array.isArray(report.attribution) ? report.attribution : []).filter(
    (e) => e && typeof e.file === 'string' && SAFE_PATH.test(e.file) && VIA.has(e.via)
  )
  if (attribution.length) {
    lines.push('| Changed file | Matched via | Tests |', '| --- | --- | --- |')
    for (const e of attribution)
      lines.push(`| \`${strip(e.file)}\` | ${e.via} | ${count(e.tests)} |`)
    lines.push('')
  }
  if (added.length) {
    const rest = added.length - Math.min(added.length, 50)
    lines.push(
      `<details><summary>${added.length} added test id(s)</summary>`,
      '',
      '```',
      ...added.slice(0, 50),
      ...(rest > 0 ? [`… and ${rest} more`] : []),
      '```',
      '',
      '</details>',
      ''
    )
  }
  if (unmapped.length) {
    lines.push(
      'These changed files map to no test, so nothing was added for them — review by hand if they affect behaviour:',
      ...unmapped.map((f) => `- \`${f}\``),
      ''
    )
  }
  if (rejected) {
    lines.push(
      `⚠️ ${rejected} affected test id(s) were rejected as unsafe to pass on a command line and were not added.`,
      ''
    )
  }
  return { include, body: lines.join('\n') }
}

// main's resolve-rerun: the failed tests of the last recorded base run, per leg, or why there is nothing to run.
export function rerunPlan(state) {
  const recorded = state.recorded
  if (!recorded || !Array.isArray(recorded.rows) || !recorded.rows.length) {
    return {
      stop:
        'No SDK e2e base run recorded on this PR. Run `test-e2e-smoke` or `test-e2e-full` first — ' +
        `\`${RERUN}\` re-runs the failures of that run.`
    }
  }
  const plan = {}
  for (const row of recorded.rows) {
    const ids = [...new Set((row.failed ?? []).map(String).filter(Boolean))]
    if (ids.length) plan[row.key] = ids
  }
  if (!Object.keys(plan).length) {
    return { stop: 'The recorded base run has no failing tests — nothing to re-run.' }
  }
  return { plan }
}

export async function plan(env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const matrices = JSON.parse(env.MATRICES || '{}')
  const labelled = matrices['test:integration:labelled'] ?? []
  const mobile = matrices['test:mobile'] ?? []
  const pr = event.pull_request?.number
  if (!pr) {
    // A dispatch runs what its inputs select, Device Farm only on the platform it names, as main's test-sdk.yml.
    const platform = env.PLATFORM && env.PLATFORM !== 'none'
    const suite = env.SUITE === 'smoke' ? 'smoke' : ''
    const options = {
      exclude: list('exclude-suite', env.EXCLUDE_SUITE),
      include: list('include', env.INCLUDE),
      inference: list('inference-version', env.INFERENCE_VERSION)
    }
    const tests = list('filter', env.FILTER)
    const rows = (rs) => rs.map((r) => ({ ...r, suite: encodeOptions(suite, options), tests }))
    return output(env, {
      mode: 'dispatch',
      suite,
      desktop: rows(labelled),
      mobile: platform ? rows(mobile) : [],
      report: [],
      comments: {}
    })
  }
  const label = event.action === 'labeled' ? event.label?.name : ''
  // Without a label only a base:<branch> key selects rows, main's release-branch run.
  const mode = label ? (MODES[label] ?? 'none') : labelled.length ? 'base' : 'none'
  const suite = label === 'test-e2e-smoke' || label === 'test-e2e-python' ? 'smoke' : ''
  let desktop = labelled
  let devices = []
  const gh = github(env)
  const runUrl = runUrlOf(env)
  if (mode === 'base') devices = mobile.filter(reported).map((r) => ({ ...r, suite }))
  // A smoke run adds the tests the PR touched, on desktop and mobile, as main's resolve-impacted did.
  if (suite === 'smoke' && ['success', 'failure'].includes(env.IMPACTED)) {
    const found = impacted({
      result: env.IMPACTED,
      include: env.IMPACTED_INCLUDE || '',
      json: env.IMPACTED_JSON || ''
    })
    if (found.include) {
      const add = (r) => ({ ...r, suite: encodeOptions(r.suite, { include: found.include }) })
      desktop = desktop.map(add)
      devices = devices.map(add)
    }
    if (found.body) {
      const { comments } = await readState(gh, pr)
      await upsert(gh, pr, comments, IMPACTED, found.body)
      summary(env, found.body)
    }
  }
  if (mode === 'rerun') {
    // GitHub only emits labeled when the label is absent, so it comes off for the next attempt.
    await gh.call('DELETE', `issues/${pr}/labels/${RERUN}`).catch((err) => {
      if (err.status !== 404) throw err
    })
    const { comments, state } = await readState(gh, pr)
    let { plan: failed, stop } = rerunPlan(state)
    if (state.running?.runId && (await isRunInFlight(gh, state.running.runId))) {
      stop =
        `Base ${describe(state.running)} has not finished, so its failure set is not known yet. Wait for the ` +
        '**QVAC E2E — base run recorded** comment, then apply the label again — it has already been removed.'
    }
    if (stop) {
      await upsert(
        gh,
        pr,
        comments,
        PLAN,
        `### QVAC E2E rerun — nothing to run\n\n${stop}\n\n[View run](${runUrl})`
      )
      console.log(`::notice::${stop}`)
      return output(env, { mode: 'none', desktop: [], mobile: [], report: [], comments: {} })
    }
    const withTests = (r) => ({ ...r, tests: failed[keyOf(r)].join(',') })
    desktop = labelled.filter((r) => failed[keyOf(r)]).map(withTests)
    devices = mobile.filter((r) => reported(r) && failed[keyOf(r)]).map(withTests)
    const count = Object.values(failed).reduce((n, ids) => n + ids.length, 0)
    const lines = [
      `### QVAC E2E rerun — ${count} previously failed test(s)`,
      `**Base:** ${describe(state.recorded)}`,
      `[View run](${runUrl})`,
      '',
      '| Leg | Tests | Test ids |',
      '| --- | --- | --- |',
      ...Object.entries(failed).map(([key, ids]) => {
        const shown = ids
          .slice(0, 8)
          .map((id) => `\`${id}\``)
          .join(', ')
        return `| \`${key}\` | ${ids.length} | ${shown}${ids.length > 8 ? `, and ${ids.length - 8} more` : ''} |`
      }),
      '',
      'This is a partial verification — it does not replace a full run, and it does not apply the `e2e-tested` label.'
    ]
    await upsert(gh, pr, comments, PLAN, lines.join('\n'))
  }
  const report = mode === 'none' ? [] : [...desktop, ...devices].filter(reported)
  const keys = report.map((r) => ({
    key: keyOf(r),
    slug: r.slug,
    config: r.config,
    tests: r.tests ?? ''
  }))
  if (mode === 'base') {
    // A rerun labelled before this run finishes is rejected; the base run starts even if this fails.
    try {
      const { comment, state } = await readState(gh, pr)
      const sha = event.pull_request.head.sha
      await writeState(gh, pr, comment, {
        recorded: state.recorded,
        running: { runId: env.GITHUB_RUN_ID, runUrl, sha, suite }
      })
    } catch (err) {
      console.log(`::warning::Could not mark the base run: ${err.message}`)
    }
  }
  const configLine = `**Mode:** \`${mode}\` · **Suite:** ${fmt(suite)}`
  const comments = report.length ? await postRunning(gh, env, pr, report, configLine) : {}
  output(env, { mode, suite, desktop, mobile: devices, report: keys, comments })
}

// A leg's results-*.json files: the artifact's own directory, or the download root when it was the only one.
function resultFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...resultFiles(path))
    else if (name.startsWith('results-') && name.endsWith('.json')) out.push(path)
  }
  return out
}

export function merge(files) {
  const merged = {
    summary: { total: 0, passed: 0, failed: 0, duration: 0 },
    categories: {},
    tests: []
  }
  for (const file of files) {
    let report
    try {
      report = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      console.log(`::warning::Failed to parse ${file}: ${err.message}`)
      continue
    }
    for (const k of ['total', 'passed', 'failed', 'duration']) {
      merged.summary[k] += Number(report.summary?.[k] || 0)
    }
    for (const [cat, c] of Object.entries(report.categories ?? {})) {
      const m = (merged.categories[cat] ??= { total: 0, passed: 0, failed: 0 })
      for (const k of ['total', 'passed', 'failed']) m[k] += Number(c[k] || 0)
    }
    merged.tests.push(...(Array.isArray(report.tests) ? report.tests : []))
  }
  const { total, passed } = merged.summary
  merged.summary.successRate = total ? ((passed / total) * 100).toFixed(1) : '0.0'
  return merged
}

const truncate = (s, n) => {
  const first = String(s || '')
    .split('\n')[0]
    .trim()
  return first.length > n ? `${first.slice(0, n - 1)}…` : first
}

// main's report-finalize body, per leg.
export function body(mark, key, results, lines) {
  const { total, passed, failed, successRate } = results.summary
  const duration = Math.round(results.summary.duration)
  if (failed === 0) {
    return [
      mark,
      `### QVAC E2E — \`${key}\` — ✅ all tests passed (${passed}/${total}, ${duration}s)`,
      ...lines
    ].join('\n')
  }
  const out = [
    mark,
    `### QVAC E2E — \`${key}\` — ❌ failed`,
    `**Totals:** ${passed}/${total} passed · ${failed} failed · ${successRate}% · ${duration}s`,
    ...lines,
    '',
    '**Results by section**'
  ]
  const cats = Object.entries(results.categories)
    .filter(([, c]) => c.failed > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  out.push(
    ...(cats.length
      ? cats.map(([cat, c]) => `- ${cat}: ${c.passed}/${c.total} ❌`)
      : ['- (no category breakdown available)'])
  )
  out.push('', '**Failed tests**')
  const failedTests = results.tests.filter((t) => t.outcome === 'failure')
  if (!failedTests.length) out.push('- (no per-test details available)')
  // Errors shared by more than five tests collapse into one line, as main's report did.
  const byError = new Map()
  for (const t of failedTests) {
    const error = truncate(t.error || 'no error message', 200)
    byError.set(error, [...(byError.get(error) ?? []), t])
  }
  const emitted = new Set()
  for (const t of [...failedTests].sort((a, b) =>
    String(a.testId).localeCompare(String(b.testId))
  )) {
    const error = truncate(t.error || 'no error message', 200)
    const group = byError.get(error)
    if (group.length > 5) {
      if (emitted.has(error)) continue
      emitted.add(error)
      const shown = group
        .slice(0, 5)
        .map((g) => `\`${g.testId}\``)
        .join(', ')
      out.push(
        `- ${group.length} tests: ${error}`,
        `  Affected: ${shown}, and ${group.length - 5} more`
      )
    } else out.push(`- \`${t.testId}\`: ${error}`)
  }
  const retried = results.tests.filter((t) => t.retried)
  if (retried.length) {
    out.push('', '**Rerun failed tests**')
    for (const t of retried) {
      out.push(
        `- \`${t.testId}\`: ${t.retryPassed ? '✅' : truncate(t.retryOutput || t.error, 200) || 'no error message'}`
      )
    }
  }
  return out.join('\n')
}

export async function report(env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const pr = event.pull_request?.number
  const mode = env.MODE
  const rows = JSON.parse(env.REPORT || '[]')
  const comments = JSON.parse(env.COMMENTS || '{}')
  const gh = github(env)
  const runUrl = runUrlOf(env)
  const root = env.RESULTS_DIR || 'results'
  const artifacts = await gh.all(`actions/runs/${env.GITHUB_RUN_ID}/artifacts`, 'artifacts')
  const names = new Set(artifacts.map((a) => a.name).filter((n) => n.includes('-results-')))
  const recorded = []
  const problems = []
  let truncated = false
  let budget = MAX_TESTS
  for (const row of rows) {
    const name = `${row.slug}-results-${row.config}`
    const dir = existsSync(join(root, name))
      ? join(root, name)
      : names.size === 1 && names.has(name)
        ? root
        : null
    const files = dir ? resultFiles(dir) : []
    const artifact = artifacts.filter((a) => a.name === name).pop()
    const lines = [
      `**Mode:** \`${mode}\` · **Suite:** ${fmt(env.SUITE)}${row.tests ? ' · **Tests:** rerun of previously failed' : ''}`
    ]
    lines.push(
      artifact
        ? `[View run](${runUrl}) · Artifacts: [reports](${runUrl}/artifacts/${artifact.id})`
        : `[View run](${runUrl})`
    )
    let text
    if (!files.length) {
      problems.push(`${row.key}: no results`)
      text = [
        marker(pr, row.key),
        `### QVAC E2E — \`${row.key}\` — ⚠️ no results`,
        ...lines,
        '',
        'The leg produced no results artifact (a job-level failure, or no device started). Check the run.'
      ].join('\n')
    } else {
      const results = merge(files)
      text = body(marker(pr, row.key), row.key, results, lines)
      if (results.summary.failed > 0) problems.push(`${row.key}: ${results.summary.failed} failed`)
      const failed = []
      for (const t of results.tests) {
        if (t.outcome !== 'failure' || !t.testId || failed.includes(String(t.testId))) continue
        if (budget-- <= 0) truncated = true
        else failed.push(String(t.testId))
      }
      recorded.push({
        key: row.key,
        total: results.summary.total,
        passed: results.summary.passed,
        failed
      })
      // main's verify-rerun: exact ids, since --filter matches by prefix and a deleted id would look covered.
      if (mode === 'rerun' && row.tests) {
        const ran = new Set(results.tests.map((t) => String(t.testId)))
        const planned = row.tests.split(',')
        const missing = planned.filter((id) => !ran.has(id))
        if (!ran.size) {
          problems.push(`${row.key}: the rerun executed 0 tests`)
        } else if (missing.length === planned.length) {
          problems.push(`${row.key}: none of the planned tests ran`)
        } else if (missing.length) {
          console.log(
            `::warning::${row.key}: planned tests that no longer exist: ${missing.join(', ')}`
          )
        }
      }
    }
    summary(env, text)
    if (pr && comments[row.key]) {
      await gh
        .call('PATCH', `issues/comments/${comments[row.key]}`, { body: text })
        .catch((err) => {
          console.log(`::warning::Could not update the comment for ${row.key}: ${err.message}`)
        })
    }
  }
  if (pr && mode === 'base') {
    const { comment, state } = await readState(gh, pr)
    const sha = event.pull_request.head.sha
    // A run whose every leg died leaves no results; the previous base is then kept.
    const next = recorded.length
      ? {
          recorded: {
            runId: env.GITHUB_RUN_ID,
            runUrl,
            sha,
            suite: env.SUITE,
            truncated,
            rows: recorded
          },
          running: null
        }
      : { recorded: state.recorded, running: null }
    await writeState(gh, pr, comment, next)
    if (!problems.length && env.LEGS_OK === 'true') {
      await gh.call('POST', `issues/${pr}/labels`, { labels: ['e2e-tested'] })
    }
  }
  if (problems.length) {
    console.log(`::error::E2E report: ${problems.join('; ')}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = { plan, report }[process.argv[2]]
  if (!command) throw new Error('usage: node ci/e2e-report.mjs plan|report')
  command(process.env).catch((err) => {
    console.log(`::error::${err.message}`)
    process.exit(1)
  })
}
