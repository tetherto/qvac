#!/usr/bin/env node
/**
 * authorize-pr reads qvac/fork-verified via the commit statuses API.
 * Job-level permissions omit statuses by default (none) — add statuses: read.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const workflowsDir = join(root, '.github/workflows')

function eachJob(source) {
  const jobsIdx = source.search(/^jobs:\s*$/m)
  if (jobsIdx === -1) return []
  const lines = source.slice(jobsIdx).split('\n')
  const jobs = []
  let cur = null
  for (const line of lines) {
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (m) {
      if (cur) jobs.push(cur)
      cur = { name: m[1], text: '' }
      continue
    }
    if (/^\S/.test(line) && cur) {
      jobs.push(cur)
      cur = null
    }
    if (cur) cur.text += line + '\n'
  }
  if (cur) jobs.push(cur)
  return jobs
}

function patchJobBlock(block, jobName) {
  if (!block.includes('./.github/actions/authorize-pr')) {
    return block
  }

  if (/statuses:\s*read/.test(block)) {
    return block
  }

  if (/^\s+permissions:\s*\n/m.test(block)) {
    return block.replace(
      /(^\s+permissions:\s*\n(?:\s+[^\n]+\n)+?)(\s+outputs:|\s+steps:)/m,
      (match, perms, next) => {
        if (/statuses:\s*read/.test(perms)) {
          return match
        }
        return `${perms}      statuses: read\n${next}`
      },
    )
  }

  return block.replace(
    /^((?:  authorize:|  resolve-config:)\n(?:    .+\n)*?)(    runs-on:)/m,
    `$1    permissions:
      contents: read
      pull-requests: write
      statuses: read
$2`,
  )
}

function processFile(path) {
  let source = readFileSync(path, 'utf8')
  if (!source.includes('./.github/actions/authorize-pr')) {
    return false
  }

  const jobsIdx = source.indexOf('\njobs:\n')
  if (jobsIdx === -1) {
    return false
  }

  const header = source.slice(0, jobsIdx + 1)
  let body = source.slice(jobsIdx + 1)
  let changed = false

  for (const jobName of ['authorize', 'resolve-config']) {
    const marker = `\n  ${jobName}:\n`
    let start = body.indexOf(marker)
    if (start === -1) {
      continue
    }
    start += 1
    const after = body.slice(start + marker.length - 1)
    const nextJob = after.search(/\n  [A-Za-z0-9_-]+:\n/)
    const end = nextJob === -1 ? body.length : start + marker.length - 1 + nextJob
    const block = body.slice(start, end)
    const patched = patchJobBlock(block, jobName)
    if (patched !== block) {
      body = body.slice(0, start) + patched + body.slice(end)
      changed = true
    }
  }

  if (!changed) {
    return false
  }

  if (!source.endsWith('\n')) {
    source = `${source}\n`
  }
  writeFileSync(path, header + body)
  return true
}

let changed = 0
for (const name of readdirSync(workflowsDir)) {
  if (!/\.ya?ml$/.test(name)) {
    continue
  }
  if (processFile(join(workflowsDir, name))) {
    changed++
    console.log(`patched: ${name}`)
  }
}
console.log(`done: ${changed} workflow(s)`)
