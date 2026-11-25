#!/usr/bin/env node
// The pull request a workflow_run build is for, read from the API. From the triggering run it takes only the head SHA,
// repository, branch and run name; its conclusion, outputs and artifacts are never read, since a fork can name a
// workflow alike.

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SHA = /^[0-9a-f]{40}$/
const same = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase()

// A base branch pattern is a name or a prefix ending in *, as a workflow's branches filter.
export function branchAllowed(ref, patterns) {
  return patterns.some((p) => (p.endsWith('*') ? ref.startsWith(p.slice(0, -1)) : ref === p))
}

// The one open PR into a built base whose head is the triggering commit, or why there is none. PRs into other bases
// are left out first, so one never blocks the other.
export function matchPr(pulls, { headSha, headRepo, repo, branches }) {
  const built = pulls.filter(
    (p) => same(p.base?.repo?.full_name, repo) && branchAllowed(p.base?.ref || '', branches)
  )
  if (built.length !== 1)
    return { skip: `${built.length} open pull requests for this branch into a built base` }
  const [pr] = built
  if (pr.head?.sha !== headSha) return { skip: `head moved from ${headSha} to ${pr.head?.sha}` }
  if (!same(pr.head?.repo?.full_name, headRepo)) return { skip: 'head repository does not match' }
  return { pr }
}

// PR checks names each run `[<action>] <title>`, or `[labeled: <label>] <title>`.
export const RUN_NAME = /^\[([a-z_]+)(?:: (.+?))?\] /

// The PR event a run stands for, from its trigger's run name. The PR's own workflow file sets that name, so a label
// counts only while it is on the PR, and a fork's run is a push unless it names a label the PR has.
export function triggerEvent(title, labels, fork) {
  const [, action = 'synchronize', label = ''] = RUN_NAME.exec(title) ?? []
  if (action === 'labeled') return { action, label: labels.includes(label) ? label : '' }
  return { action: fork ? 'synchronize' : action, label: '' }
}

export const touchesCi = (files) =>
  files.some((f) => [f.filename, f.previous_filename].some((p) => p?.startsWith('.github/')))

const list = (s) =>
  (s || '')
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean)

function github(env) {
  const base = env.GITHUB_API_URL || 'https://api.github.com'
  const get = async (path) => {
    const res = await fetch(`${base}/${path}`, {
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28'
      }
    })
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
    return res.json()
  }
  const post = async (path, body) => {
    const res = await fetch(`${base}/${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28'
      }
    })
    if (!res.ok) throw new Error(`POST ${path}: ${res.status}`)
  }
  const all = async (path, key) => {
    const out = []
    for (let page = 1; ; page++) {
      const body = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      const items = key ? body[key] : body
      out.push(...items)
      if (items.length < 100 || page >= 30) return out
    }
  }
  return { get, all, post }
}

function write(env, values) {
  const lines = Object.entries(values).map(
    ([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`
  )
  console.log(lines.join('\n'))
  appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

// The run's commit status on the PR head, posted here and by the run's last job, neither of which runs PR code.
const status = (gh, env, sha, state, description) =>
  env.STATUS_CONTEXT &&
  gh.post(`repos/${env.GITHUB_REPOSITORY}/statuses/${sha}`, {
    state,
    context: env.STATUS_CONTEXT,
    description: description.slice(0, 140),
    target_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  })

// A `/merge-guard accept <sha>` naming this head, from someone with write access, as Merge Guard reads it.
export async function accepted(gh, repo, number, headSha) {
  for (const c of await gh.all(`repos/${repo}/issues/${number}/comments`)) {
    // The full SHA: a short prefix can be matched by another commit a fork author searches for.
    const sha = /^\/merge-guard accept ([0-9a-f]{40})\b/.exec(c.body?.trim() ?? '')?.[1]
    if (sha !== headSha) continue
    const { permission } = await gh.get(
      `repos/${repo}/collaborators/${encodeURIComponent(c.user.login)}/permission`
    )
    if (['admin', 'write'].includes(permission)) return true
  }
  return false
}

async function main(env) {
  const repo = env.GITHUB_REPOSITORY
  // Merge Guard's accept dispatches a build of one PR head; it is checked below as a workflow_run build is.
  const dispatched = env.GITHUB_EVENT_NAME === 'workflow_dispatch' && Boolean(env.DISPATCH_PR)
  if (env.GITHUB_EVENT_NAME !== 'workflow_run' && !dispatched) {
    // A dispatch builds its own ref from its own workflow file, as before.
    return write(env, {
      ok: 'true',
      sha: env.GITHUB_SHA,
      repository: repo,
      'same-repo': 'true',
      fork: 'false'
    })
  }
  const skip = (why) => {
    console.log(`::notice::Not building: ${why}`)
    write(env, { ok: 'false', refused: '' })
  }
  const gh = github(env)
  const headSha = dispatched ? env.DISPATCH_SHA : env.HEAD_SHA
  let pr
  if (dispatched) {
    if (!/^\d+$/.test(env.DISPATCH_PR) || !SHA.test(headSha || ''))
      return skip('a PR dispatch names the PR number and its 40-character head')
    pr = await gh.get(`repos/${repo}/pulls/${env.DISPATCH_PR}`)
    if (
      pr.state !== 'open' ||
      !same(pr.base?.repo?.full_name, repo) ||
      !branchAllowed(pr.base.ref, list(env.BRANCHES))
    )
      return skip(`PR #${pr.number} is not open into a built base`)
    if (pr.head?.sha !== headSha) return skip(`head moved from ${headSha} to ${pr.head?.sha}`)
  } else {
    const headRepo = env.HEAD_REPO
    if (!SHA.test(headSha || '') || !headRepo || !env.HEAD_BRANCH)
      return skip('no head commit in the trigger')
    const owner = headRepo.split('/')[0]
    const pulls = await gh.get(
      `repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${env.HEAD_BRANCH}`)}&per_page=100`
    )
    const match = matchPr(pulls, { headSha, headRepo, repo, branches: list(env.BRANCHES) })
    if (!match.pr) return skip(match.skip)
    pr = match.pr
  }
  const files = await gh.all(`repos/${repo}/pulls/${pr.number}/files`)
  // The files are the PR's current ones, so they describe headSha only if the head did not move while they were read.
  const after = await gh.get(`repos/${repo}/pulls/${pr.number}`)
  if (after.head?.sha !== headSha) return skip(`head moved from ${headSha} to ${after.head?.sha}`)
  const prefixes = list(env.PATHS)
  if (prefixes.length && !files.some((f) => prefixes.some((p) => f.filename.startsWith(p))))
    return skip(`PR #${pr.number} changes nothing under ${prefixes.join(' ')}`)
  const fork = !same(pr.head.repo.full_name, repo)

  // The event payload still holds the PR title at this point; the API has the run name once it is evaluated. A
  // dispatch builds the head as a push would.
  let title = dispatched ? '[synchronize] ' : ''
  for (let i = 0; i < 5 && !RUN_NAME.test(title); i++) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 3000))
    title = (await gh.get(`repos/${repo}/actions/runs/${env.TRIGGER_ID}`)).display_title ?? ''
  }
  let { action, label } = triggerEvent(
    title,
    pr.labels.map((l) => l.name),
    fork
  )
  // A label this workflow does not route by reruns it as a push would.
  const routed = list(env.LABELS)
  if (label && routed.length && !routed.includes(label))
    ({ action, label } = { action: 'synchronize', label: '' })

  if (fork) {
    // A fork names its files, so nothing in a name may break out of its table cell and mislead the approver.
    const cell = (s) => JSON.stringify(s).replace(/[`|<>]/g, (c) => `&#${c.charCodeAt(0)};`)
    const rows = files.map(
      (f) => `| ${cell(f.filename)} | ${f.status} | +${f.additions} -${f.deletions} |`
    )
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        `### Fork PR #${pr.number} from ${pr.head.repo.full_name} at \`${headSha}\``,
        'Approving `fork-ci` runs this commit with AWS access on self-hosted runners. Changed files:',
        '',
        '| File | Status | Lines |',
        '| --- | --- | --- |',
        ...rows,
        ''
      ].join('\n') + '\n'
    )
  }
  // A truncated list cannot prove the PR leaves .github alone. A maintainer's accept of this head lifts it after review.
  if (
    fork &&
    (touchesCi(files) || files.length >= 3000) &&
    !(await accepted(gh, repo, pr.number, headSha))
  ) {
    const reason = `Fork PR changes .github/; after review, a maintainer comments /merge-guard accept ${headSha}`
    console.log(`::error title=Fork PR changes CI files::${reason}`)
    await status(gh, env, headSha, 'failure', reason)
    return write(env, { ok: 'false', refused: reason, pr: String(pr.number), sha: headSha })
  }
  await status(gh, env, headSha, 'pending', fork ? 'Waiting for fork-ci approval' : 'Running')
  const labels = pr.labels.map((l) => l.name)
  const event = {
    action,
    label: label ? { name: label } : null,
    number: pr.number,
    repository: { default_branch: env.DEFAULT_BRANCH },
    pull_request: {
      number: pr.number,
      draft: pr.draft,
      updated_at: pr.updated_at,
      labels: labels.map((name) => ({ name })),
      head: { sha: headSha, ref: pr.head.ref, repo: { full_name: pr.head.repo.full_name } },
      base: { sha: pr.base.sha, ref: pr.base.ref, repo: { full_name: repo } }
    }
  }
  write(env, {
    ok: 'true',
    refused: '',
    pr: String(pr.number),
    sha: headSha,
    repository: pr.head.repo.full_name,
    'same-repo': String(!fork),
    fork: String(fork),
    draft: String(pr.draft),
    'base-ref': pr.base.ref,
    'base-sha': pr.base.sha,
    labels: JSON.stringify(labels),
    action,
    label,
    event: JSON.stringify(event)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.env).catch((err) => {
    console.log(`::error::${err.message}`)
    process.exit(1)
  })
