#!/usr/bin/env node
// Merge Guard: evaluates .github/merge-rules.yml against the producers' job results and posts one status.

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const CONTEXT = 'qvac-merge-guard / validate-pr'
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'])
const ICON = { success: '✅', failure: '❌', pending: '⏳', skipped: '⏭️' }

export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c !== '*') re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    else if (glob[i + 1] !== '*') re += '[^/]*'
    else if (glob[i + 2] === '/') (re += '(?:.*/)?'), (i += 2)
    else (re += '.*'), i++
  }
  return new RegExp(`^${re}$`)
}

export const nameMatches = (pattern, name) =>
  new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(name)

export function matchRules(rules, files) {
  return rules
    .map((rule) => {
      const include = rule.patterns.filter((p) => !p.startsWith('-')).map(globToRegExp)
      const exclude = rule.patterns.filter((p) => p.startsWith('-')).map((p) => globToRegExp(p.slice(1)))
      const matched = files.filter((f) => include.some((r) => r.test(f)) && !exclude.some((r) => r.test(f)))
      return { ...rule, matched }
    })
    .filter((rule) => rule.matched.length > 0)
}

export function requiredChecks(rules) {
  const checks = new Map()
  for (const rule of rules)
    for (const c of rule.checks) {
      const key = `${c.workflow}\u0000${c.job}`
      const prev = checks.get(key)
      checks.set(key, {
        workflow: c.workflow,
        job: c.job,
        skipped: prev ? prev.skipped && c.skipped === 'pass' : c.skipped === 'pass',
        rules: [...(prev?.rules ?? []), rule.name]
      })
    }
  return [...checks.values()]
}

// Per job name, the newest attempt that did not skip counts.
export function resolveCheck(check, runs) {
  const byName = new Map()
  for (const run of runs)
    for (const job of run.jobs.filter((j) => nameMatches(check.job, j.name))) {
      if (!byName.has(job.name)) byName.set(job.name, [])
      byName.get(job.name).push(job)
    }
  const producerDone = runs.length > 0 && runs.every((r) => r.status === 'completed')
  if (byName.size === 0)
    return producerDone
      ? { result: check.skipped ? 'skipped' : 'failure', jobs: [], note: 'not run' }
      : { result: 'pending', jobs: [] }
  const picked = [...byName.values()].map((jobs) => jobs.find((j) => !(j.status === 'completed' && j.conclusion === 'skipped')) ?? jobs[0])
  const outcome = (j) => (j.status !== 'completed' ? 'pending' : FAILED.has(j.conclusion) ? 'failure' : j.conclusion === 'skipped' ? 'skipped' : 'success')
  const results = picked.map(outcome)
  let result = 'success'
  if (results.includes('failure') || (!check.skipped && results.includes('skipped'))) result = 'failure'
  else if (results.includes('pending')) result = 'pending'
  else if (results.every((r) => r === 'skipped')) result = 'skipped'
  return { result, jobs: picked.map((j) => ({ ...j, outcome: outcome(j) })) }
}

export function verdict(resolved) {
  const failed = resolved.filter((c) => c.result === 'failure')
  const pending = resolved.filter((c) => c.result === 'pending')
  const names = (cs) =>
    [...new Set(cs.flatMap((c) => {
      const bad = c.jobs.filter((j) => j.outcome !== 'success').map((j) => j.name)
      return bad.length ? bad : [c.job]
    }))]
  if (failed.length) return { state: 'failure', description: `failed: ${names(failed).join(', ')}` }
  if (pending.length)
    return { state: 'pending', description: `waiting: ${[...new Set(pending.map((c) => c.producer))].join(', ')}` }
  return { state: 'success', description: `${resolved.length} required checks passed` }
}

function github(env) {
  const base = env.GITHUB_API_URL || 'https://api.github.com'
  const request = async (method, path, body) => {
    const res = await fetch(`${base}/${path}`, {
      method,
      body: body && JSON.stringify(body),
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28'
      }
    })
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`)
    return res.status === 204 ? null : res.json()
  }
  const get = (path) => request('GET', path)
  const all = async (path, key) => {
    const out = []
    for (let page = 1; page <= 30; page++) {
      const body = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      const items = key ? body[key] : body
      out.push(...items)
      if (items.length < 100) break
    }
    return out
  }
  return { get, all, post: (path, body) => request('POST', path, body) }
}

async function findPr(gh, env, event) {
  const repo = env.GITHUB_REPOSITORY
  const number = env.PR
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const run = event.workflow_run
    const owner = run.head_repository?.full_name?.split('/')[0]
    const pulls = await gh.get(
      `repos/${repo}/pulls?state=open&per_page=100&head=${encodeURIComponent(`${owner}:${run.head_branch}`)}`
    )
    const pr = pulls.find((p) => p.head.sha === run.head_sha && p.base.ref === env.DEFAULT_BRANCH)
    return pr ? { pr } : { why: `no open PR into ${env.DEFAULT_BRANCH} at ${run.head_sha}` }
  }
  if (!/^\d+$/.test(String(number ?? ''))) return { why: 'no PR number in the trigger' }
  const pr = await gh.get(`repos/${repo}/pulls/${number}`)
  if (pr.state !== 'open') return { why: `PR #${number} is ${pr.state}` }
  if (pr.base.ref !== env.DEFAULT_BRANCH) return { why: `PR #${number} is into ${pr.base.ref}` }
  if (env.SHA && pr.head.sha !== env.SHA) return { why: `PR #${number} moved on from ${env.SHA}` }
  return { pr }
}

// pull_request runs by head SHA; workflow_run runs by the head SHA in their run-name.
async function producerRuns(gh, env, file, pr) {
  const repo = env.GITHUB_REPOSITORY
  const path = `.github/workflows/${file}`
  const runs = [
    ...(await gh.get(`repos/${repo}/actions/workflows/${file}/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`))
      .workflow_runs.filter((r) => r.head_repository?.full_name === pr.head.repo?.full_name),
    ...(await gh.get(`repos/${repo}/actions/workflows/${file}/runs?event=workflow_run&per_page=100`)).workflow_runs.filter(
      (r) => r.head_branch === env.DEFAULT_BRANCH && r.display_title.includes(pr.head.sha)
    )
  ]
    .filter((r) => r.path === path)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
  for (const run of runs) run.jobs = await gh.all(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs')
  return runs
}

// Escapes fork-controlled names in the summary table.
const cell = (s) => String(s).replace(/[`|<>[\]*_\\]/g, (c) => `&#${c.charCodeAt(0)};`)

function summary(pr, rules, resolved, { state, description }) {
  const failedStep = (j) => j.steps?.find((s) => FAILED.has(s.conclusion))?.name
  const rows = resolved.map((c) => {
    const jobs = c.jobs.length
      ? c.jobs
          .map((j) => `[${cell(j.name)}](${j.html_url}) ${ICON[j.outcome]}${failedStep(j) ? ` at ${cell(failedStep(j))}` : ''}`)
          .join('<br>')
      : c.note ?? 'not reported yet'
    return `| ${c.rules.join('<br>')} | ${c.producer}: <code>${cell(c.job)}</code> | ${ICON[c.result]} ${c.result} | ${jobs} |`
  })
  const matched = rules.map(
    (r) => `- **${r.name}**: ${r.matched.slice(0, 5).map((f) => `<code>${cell(f)}</code>`).join(', ')}${r.matched.length > 5 ? ` and ${r.matched.length - 5} more` : ''}`
  )
  return [
    `### Merge Guard ${ICON[state] ?? ''} ${description}`,
    `PR #${pr.number} at \`${pr.head.sha}\``,
    '',
    '| Rule | Check | Result | Jobs |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    'Rules brought in by:',
    ...matched,
    ''
  ].join('\n')
}

async function main(env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  const gh = github(env)
  const { pr, why } = await findPr(gh, env, event)
  if (!pr) return console.log(`::notice::Not evaluating: ${why}`)
  const sha = pr.head.sha

  const files = (await gh.all(`repos/${env.GITHUB_REPOSITORY}/pulls/${pr.number}/files`)).flatMap((f) =>
    [f.filename, f.previous_filename].filter(Boolean)
  )
  const rules = matchRules(JSON.parse(readFileSync(env.RULES_JSON, 'utf8')), files)
  const checks = requiredChecks(rules)
  const runs = {}
  for (const file of new Set(checks.map((c) => c.workflow))) runs[file] = await producerRuns(gh, env, file, pr)
  const resolved = checks.map((c) => ({
    ...c,
    producer: runs[c.workflow][0]?.name ?? c.workflow,
    ...resolveCheck(c, runs[c.workflow])
  }))
  // A fork PR's pull_request runs use its own workflow files, so it could replace the checks it is judged on.
  const forkEditsCi = pr.head.repo?.full_name !== env.GITHUB_REPOSITORY && files.some((f) => f.startsWith('.github/'))
  const result = forkEditsCi
    ? { state: 'failure', description: 'fork PRs that change .github/ are not accepted; a maintainer re-raises them from a branch' }
    : verdict(resolved)
  appendFileSync(env.GITHUB_STEP_SUMMARY, summary(pr, rules, resolved, result))

  const now = await gh.get(`repos/${env.GITHUB_REPOSITORY}/pulls/${pr.number}`)
  if (now.head.sha !== sha) return console.log(`::notice::Head moved from ${sha} to ${now.head.sha}; not reporting`)
  await gh.post(`repos/${env.GITHUB_REPOSITORY}/statuses/${sha}`, {
    state: result.state,
    context: CONTEXT,
    description: result.description.length > 140 ? `${result.description.slice(0, 137)}...` : result.description,
    target_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  })
  console.log(`${CONTEXT} = ${result.state}: ${result.description}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.env).catch((err) => {
    console.log(`::error::${err.message}`)
    process.exit(1)
  })
