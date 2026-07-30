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

function appendStatusesReadToPermissions(block) {
  const headerMatch = block.match(/^(\s+permissions:\s*\n)/m)
  if (!headerMatch) {
    return null
  }

  const bodyStart = headerMatch.index + headerMatch[0].length
  const tail = block.slice(bodyStart)
  const nextSection = tail.search(/^\s+(?:outputs:|steps:|runs-on:)/m)
  if (nextSection === -1) {
    return null
  }

  const permSection = block.slice(headerMatch.index, bodyStart + nextSection)
  if (/statuses:\s*read/.test(permSection)) {
    return block
  }

  const insertAt = bodyStart + nextSection
  return `${block.slice(0, insertAt)}      statuses: read\n${block.slice(insertAt)}`
}

function patchJobBlock(block) {
  if (!block.includes('./.github/actions/authorize-pr')) {
    return block
  }

  if (/statuses:\s*read/.test(block)) {
    return block
  }

  const withPermissions = appendStatusesReadToPermissions(block)
  if (withPermissions !== null) {
    return withPermissions
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
  const source = readFileSync(path, 'utf8')
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
    const patched = patchJobBlock(block)
    if (patched !== block) {
      body = body.slice(0, start) + patched + body.slice(end)
      changed = true
    }
  }

  if (!changed) {
    return false
  }

  let output = header + body
  if (!output.endsWith('\n')) {
    output += '\n'
  }
  writeFileSync(path, output)
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
