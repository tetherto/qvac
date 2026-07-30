#!/usr/bin/env node
/**
 * Ensure every fork-approval reusable-workflow caller declares statuses: write.
 * Reusable workflows cannot elevate the caller's GITHUB_TOKEN permissions.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const workflowsDir = join(root, '.github/workflows')

const CALLER_WITHOUT_PERMISSIONS = `  fork-approval:
    uses: ./.github/workflows/reusable-fork-approval.yml
    secrets: inherit
`

const CALLER_WITH_PERMISSIONS = `  fork-approval:
    permissions:
      statuses: write
    uses: ./.github/workflows/reusable-fork-approval.yml
    secrets: inherit
`

let changed = 0
for (const name of readdirSync(workflowsDir)) {
  if (!/\.ya?ml$/.test(name) || name === 'reusable-fork-approval.yml') continue
  const path = join(workflowsDir, name)
  const source = readFileSync(path, 'utf8')
  if (!source.includes('reusable-fork-approval.yml')) continue
  if (source.includes('fork-approval:\n    permissions:\n      statuses: write')) continue
  if (!source.includes(CALLER_WITHOUT_PERMISSIONS)) {
    console.error(`skip (unexpected fork-approval shape): ${name}`)
    continue
  }
  writeFileSync(path, source.replaceAll(CALLER_WITHOUT_PERMISSIONS, CALLER_WITH_PERMISSIONS))
  changed++
  console.log(`updated ${name}`)
}

if (changed === 0) {
  console.log('no files matched (already fixed?)')
}
