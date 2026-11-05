#!/usr/bin/env node
// Posts a run's results on the dispatched branch's open PR, one comment per key, edited in place on later runs.
// `mobile` reads devicefarm-summarize-results' test-case-details.json; `report` posts a markdown file as is.
// A branch with no open PR posts nothing.

import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ICON = { passed: '✅', failed: '❌', skipped: '⏭️' }

export function mobileBody({ npm, platform, state, details, runUrl }) {
  const head = `### Mobile tests: ${npm} (${platform})`
  if (!state) return [head, '', `⏳ Running. [Run](${runUrl})`].join('\n')
  const { devices = [], testCases = [] } = details ?? {}
  const failed = devices.map((d) => [
    d,
    testCases.filter((t) => t.results[d]?.status === 'failed').map((t) => t.test)
  ])
  const ok = state === 'success' && devices.length > 0 && failed.every(([, f]) => !f.length)
  const out = [head, '', `${ok ? '✅ Passed' : '❌ Failed'}. [Run](${runUrl})`, '']
  if (!devices.length) out.push('No device reported results.')
  for (const [device, tests] of failed) {
    const n = testCases.filter((t) => t.results[device]).length
    out.push(`- **${device}**: ${tests.length ? `${tests.length} of ${n} failed` : `${n} passed`}`)
    for (const t of tests) out.push(`  - ${ICON.failed} ${t}`)
  }
  return out.join('\n')
}

async function api(path, init = {}) {
  const res = await fetch(`${process.env.GITHUB_API_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json'
    }
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function upsert(repo, branch, key, body) {
  const owner = repo.split('/')[0]
  const [pr] = await api(
    `/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}&per_page=1`
  )
  if (!pr) return console.log(`No open PR for ${branch}; nothing to post.`)
  const marker = `<!-- pr-comment:${key} -->`
  for (let page = 1; ; page++) {
    const comments = await api(`/repos/${repo}/issues/${pr.number}/comments?per_page=100&page=${page}`)
    const hit = comments.find((c) => c.body?.startsWith(marker))
    if (hit)
      return api(`/repos/${repo}/issues/comments/${hit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body: `${marker}\n${body}` })
      })
    if (comments.length < 100) break
  }
  return api(`/repos/${repo}/issues/${pr.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: `${marker}\n${body}` })
  })
}

async function main(kind, env) {
  const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  const branch = env.GITHUB_REF_NAME
  if (kind === 'mobile') {
    const file = env.DETAILS ?? ''
    const details = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
    const body = mobileBody({ npm: env.NPM, platform: env.PLATFORM, state: env.STATE, details, runUrl })
    return upsert(env.GITHUB_REPOSITORY, branch, `mobile:${env.NPM}:${env.PLATFORM}`, body)
  }
  if (kind === 'report') {
    const body = `${readFileSync(env.REPORT, 'utf8')}\n\n[Run](${runUrl})`
    return upsert(env.GITHUB_REPOSITORY, branch, `report:${env.KEY}`, body)
  }
  throw new Error('usage: pr-comment.mjs mobile|report')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  // A comment is a convenience: failing to post it warns instead of failing the run.
  await main(process.argv[2], process.env).catch((e) =>
    console.log(`::warning::could not comment on the PR: ${e.message}`)
  )
