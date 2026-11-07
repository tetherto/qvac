#!/usr/bin/env node
// One table per run: a row per package, a column per stage, and every failed job with its failing step and a link.

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ICON = { success: '✅', failure: '❌', cancelled: '🚫', skipped: '⏭️', pending: '⏳' }
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure'])

// "build / vla-ggml win32-x64", "build / reuse vla-ggml win32-x64" (a leg taken from an earlier run) or
// "status vla-ggml": the stage, then the package, then the configuration.
export function classify(name, slugs) {
  const stage = name.includes(' / ') ? name.split(' / ')[0] : name.split(' ')[0]
  let rest = name.slice(name.includes(' / ') ? stage.length + 3 : stage.length).trim()
  const reused = rest.startsWith('reuse ')
  if (reused) rest = rest.slice(6)
  const pkg = [...slugs]
    .sort((a, b) => b.length - a.length)
    .find((s) => rest === s || rest.startsWith(`${s} `))
  return { stage, pkg: pkg ?? '', config: pkg ? rest.slice(pkg.length).trim() : rest, reused }
}

const outcome = (job) => (job.status === 'completed' ? job.conclusion : 'pending')

function cell(jobs, reused = 0) {
  if (!jobs?.length) return ''
  const note = reused ? ` (${reused} reused)` : ''
  const states = jobs.map(outcome)
  const passed = states.filter((s) => s === 'success').length
  const worst = ['failure', 'timed_out', 'startup_failure', 'cancelled', 'pending'].find((s) =>
    states.includes(s)
  )
  if (worst) return `${ICON[worst] ?? '❌'} ${passed}/${jobs.length}${note}`
  if (states.every((s) => s === 'skipped')) return ICON.skipped
  return jobs.length > 1
    ? `${ICON.success} ${passed}/${jobs.length}${note}`
    : `${ICON.success}${note}`
}

export function summarize({ jobs, slugs, title, self = 'summary' }) {
  // A skipped job in a reusable workflow keeps its unrendered ${{ }} name; it ran nothing worth a row.
  const real = jobs.filter((j) => j.name !== self && !j.name.includes('${{'))
  const rows = real.map((j) => ({ ...classify(j.name, slugs), job: j }))
  const stages = [...new Set(rows.filter((r) => r.pkg).map((r) => r.stage))]
  const lines = [`## ${title}`, '']
  // Jobs that belong to no package, one entry per name: "select ✅ · build plan ✅".
  const setup = Map.groupBy(
    rows.filter((r) => !r.pkg),
    (r) => (/^[a-z-]+$/.test(r.config) && r.config !== r.stage ? `${r.stage} ${r.config}` : r.stage)
  )
  if (setup.size)
    lines.push(
      `Setup: ${[...setup].map(([name, rs]) => `${name} ${cell(rs.map((r) => r.job))}`).join(' · ')}`,
      ''
    )
  if (stages.length) {
    lines.push(`| Package | ${stages.join(' | ')} |`, `|---|${stages.map(() => '---').join('|')}|`)
    for (const pkg of slugs) {
      lines.push(
        `| ${pkg} | ${stages
          .map((s) => {
            const rs = rows.filter((r) => r.pkg === pkg && r.stage === s)
            return cell(
              rs.map((r) => r.job),
              rs.filter((r) => r.reused).length
            )
          })
          .join(' | ')} |`
      )
    }
    lines.push('')
  }
  const failed = rows.filter((r) => FAILED.has(outcome(r.job)))
  if (failed.length) {
    lines.push(
      '### Failed',
      '',
      '| Package | Stage | Configuration | Step | Job |',
      '|---|---|---|---|---|'
    )
    for (const r of failed) {
      const step = r.job.steps?.find((s) => FAILED.has(s.conclusion))?.name ?? ''
      lines.push(
        `| ${r.pkg || '-'} | ${r.stage} | ${r.config || '-'} | ${step} | [logs](${r.job.html_url}) |`
      )
    }
    lines.push('')
  }
  return { markdown: lines.join('\n'), failed: failed.length }
}

async function jobsOf(env) {
  const out = []
  for (let page = 1; ; page++) {
    const url = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json' }
    })
    if (!res.ok) throw new Error(`listing this run's jobs failed: ${res.status}`)
    const { jobs } = await res.json()
    out.push(...jobs)
    if (jobs.length < 100) return out
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const slugs = JSON.parse(env.PROJECTS || '[]').map((p) => p.slug)
  const { markdown, failed } = summarize({ jobs: await jobsOf(env), slugs, title: env.TITLE })
  console.log(markdown)
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  if (failed) process.exit(1)
}
