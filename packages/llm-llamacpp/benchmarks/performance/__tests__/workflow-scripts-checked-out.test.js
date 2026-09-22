'use strict'

// Every local script a job runs must be in that job's sparse checkout.
//
// A sparse checkout takes only the paths it lists, so a job that runs
// `node .github/scripts/foo.js` without listing it fails at dispatch with
// "file not found". Local runs never catch this — the working tree has
// everything. This shipped twice: once when the scripts were extracted, and
// again when restructuring the context job silently dropped them from its
// list.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..')
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'benchmark-perf-llm-llamacpp.yml')

// Minimal, indentation-driven scan of `jobs:` -> steps, enough to pair each
// job's sparse-checkout list with the local scripts its steps invoke. A YAML
// library is not available to this package's test deps.
function parseJobs(text) {
  const lines = text.split('\n')
  const jobs = {}
  let current = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const jobMatch = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line)
    if (jobMatch && !/^ {4}/.test(lines[i + 1] || '') === false) {
      current = jobMatch[1]
      jobs[current] = { sparse: [], scripts: [] }
      continue
    }
    if (!current) continue
    // sparse-checkout block: subsequent more-indented non-key lines are paths
    if (/^\s*sparse-checkout:\s*\|/.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const p = lines[j].trim()
        if (!p || /:/.test(p)) break
        jobs[current].sparse.push(p)
      }
    }
    for (const m of line.matchAll(/(?:node|python3)\s+(\.github\/scripts\/[\w./-]+)/g)) {
      jobs[current].scripts.push(m[1])
    }
  }
  return jobs
}

const jobs = parseJobs(fs.readFileSync(WORKFLOW, 'utf8'))

test('the workflow is parsed into jobs with steps', () => {
  assert.ok(Object.keys(jobs).length > 3, `parsed jobs: ${Object.keys(jobs)}`)
  const withScripts = Object.entries(jobs).filter(([, j]) => j.scripts.length > 0)
  assert.ok(withScripts.length >= 2, 'at least the context and verify-shards jobs invoke scripts')
})

test('every local script a job runs exists on disk', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const script of job.scripts) {
      assert.ok(
        fs.existsSync(path.join(REPO, script)),
        `job "${name}" runs ${script}, which does not exist`
      )
    }
  }
})

test('every local script a job runs is in that job sparse checkout', () => {
  for (const [name, job] of Object.entries(jobs)) {
    if (job.scripts.length === 0) continue
    // A job with no sparse-checkout gets the full tree, which is fine.
    if (job.sparse.length === 0) continue
    for (const script of job.scripts) {
      assert.ok(
        job.sparse.includes(script),
        `job "${name}" runs ${script} but does not check it out.\n` +
          `  sparse-checkout: ${job.sparse.join(', ')}`
      )
    }
  }
})

test('sparse checkouts list only paths that exist', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const p of job.sparse) {
      assert.ok(
        fs.existsSync(path.join(REPO, p)),
        `job "${name}" checks out ${p}, which does not exist`
      )
    }
  }
})
