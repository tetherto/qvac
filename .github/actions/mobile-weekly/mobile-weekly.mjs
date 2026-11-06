#!/usr/bin/env node
// The weekend mobile run, for any package whose test/mobile/test-groups.json has androidWeekly or iosWeekly groups.
// `find` lists those packages per platform; `report` files one weekly-mobile-report issue per package, in the shape
// main's weekend run filed for llm-llamacpp.

import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function find(root) {
  const out = { android: [], ios: [] }
  for (const dir of readdirSync(join(root, 'packages')).sort()) {
    const file = join(root, 'packages', dir, 'test/mobile/test-groups.json')
    if (!existsSync(file)) continue
    const groups = JSON.parse(readFileSync(file, 'utf8'))
    for (const p of ['android', 'ios']) if (groups[`${p}Weekly`]) out[p].push(dir)
  }
  return out
}

// Total, passed, failed and skipped test cases on one platform, from devicefarm-summarize-results' test-case-details.json.
// A case that neither passed on every device nor failed on one counts as skipped.
export function counts(file) {
  if (!existsSync(file)) return null
  const { testCases = [] } = JSON.parse(readFileSync(file, 'utf8'))
  const status = (t) => {
    const s = Object.values(t.results).map((r) => r.status)
    return s.includes('failed') ? 'failed' : s.length && s.every((x) => x === 'passed') ? 'passed' : 'skipped'
  }
  const named = (want) => testCases.filter((t) => status(t) === want).map((t) => t.test)
  const skipped = named('skipped')
  return {
    total: testCases.length,
    passed: named('passed').length,
    failed: named('failed').length,
    skipped: skipped.length,
    skippedNames: skipped
  }
}

export function body(npm, rows, runUrl) {
  const result = (c) =>
    !c ? '⚠️ no run' : c.failed ? '❌ failed' : c.skipped ? '⚠️ skipped tests' : '✅ passed'
  const ran = rows.filter(([, c]) => c)
  const overall = !ran.length
    ? '⚠️ no results (jobs skipped or errored)'
    : ran.some(([, c]) => c.failed)
      ? '❌ failures detected'
      : ran.some(([, c]) => c.skipped)
        ? '⚠️ passed with skipped tests'
        : '✅ all passed'
  return [
    `Automated weekend mobile run for **${npm}**.`,
    '',
    `**Overall: ${overall}**`,
    '',
    '| Platform | Result | Total | Passed | Failed | Skipped |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      ([p, c]) =>
        `| ${p} | ${result(c)} | ${c?.total ?? '–'} | ${c?.passed ?? '–'} | ${c?.failed ?? '–'} | ${c?.skipped ?? '–'} |`
    ),
    ...ran
      .filter(([, c]) => c.skipped)
      .flatMap(([p, c]) => ['', `Skipped on ${p}: ${c.skippedNames.map((n) => `\`${n}\``).join(', ')}`]),
    '',
    `Full per-test tables and Device Farm run links are on the [workflow run summary](${runUrl}).`,
    '',
    'Weekly coverage: the androidWeekly/iosWeekly groups in test/mobile/test-groups.json.'
  ].join('\n')
}

async function api(env, path, init = {}) {
  const res = await fetch(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json'
    }
  })
  if (!res.ok && !(init.allow ?? []).includes(res.status))
    throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`)
  return res
}

async function report(env) {
  const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  // One JSON array of _select-projects projects per line, one line per platform.
  const projects = (env.PROJECTS || '').split('\n').filter((l) => l.trim()).flatMap((l) => JSON.parse(l))
  const seen = new Set()
  const label = {
    name: 'weekly-mobile-report',
    color: '1d76db',
    description: 'Automated weekend mobile test reports'
  }
  // 422: the label exists already.
  await api(env, '/labels', { method: 'POST', body: JSON.stringify(label), allow: [422] })
  const date = new Date().toISOString().slice(0, 10)
  for (const { slug, npm } of projects) {
    if (seen.has(slug)) continue
    seen.add(slug)
    const rows = ['Android', 'iOS'].map((p) => [
      p,
      counts(join(env.LOGS, `console-logs-${slug}-${p}`, 'test-case-details.json'))
    ])
    const issue = {
      title: `Weekend Mobile Tests (${npm}) — ${date}`,
      labels: [label.name],
      body: body(npm, rows, runUrl)
    }
    await api(env, '/issues', { method: 'POST', body: JSON.stringify(issue) })
    console.log(`Filed the weekly report for ${npm}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2]
  if (command === 'find') {
    const out = find(process.env.ROOT || '.')
    console.log(`Weekly groups: android ${out.android.join(',') || '-'}, ios ${out.ios.join(',') || '-'}`)
    appendFileSync(process.env.GITHUB_OUTPUT, `android=${out.android.join(',')}\nios=${out.ios.join(',')}\n`)
  } else if (command === 'report') await report(process.env)
  else throw new Error('usage: mobile-weekly.mjs find|report')
}
