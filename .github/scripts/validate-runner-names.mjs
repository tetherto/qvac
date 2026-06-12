#!/usr/bin/env node
/**
 * Fail when workflow files contain hardcoded runner labels instead of env.RN_*.
 *
 * Usage: node .github/scripts/validate-runner-names.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const runnersYamlPath = path.join(repoRoot, '.github/actions/runner-names/runners.yaml')
const workflowsDir = path.join(repoRoot, '.github/workflows')

function parseRunnersYaml (text) {
  const values = new Set()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const value = trimmed.slice(colon + 1).trim()
    if (value) values.add(value)
  }
  return values
}

function isIgnoredLine (line) {
  const trimmed = line.trim()
  if (trimmed.startsWith('#')) return true
  if (/^\s*RN_[A-Z0-9_]+:/.test(line)) return true
  if (/env\.RN_[A-Z0-9_]+/.test(line)) return true
  if (/steps\.runner_names\.outputs\./.test(line)) return true
  if (/description:/.test(line)) return true
  if (/^\s*-?\s*name:/.test(line)) return true
  if (/GITHUB_STEP_SUMMARY/.test(line)) return true
  if (/^\s*#/.test(line)) return true
  return false
}

function main () {
  const runnerValues = parseRunnersYaml(fs.readFileSync(runnersYamlPath, 'utf8'))
  const sorted = [...runnerValues].sort((a, b) => b.length - a.length)
  const failures = []

  for (const name of fs.readdirSync(workflowsDir)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue
    const filePath = path.join(workflowsDir, name)
    const lines = fs.readFileSync(filePath, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (isIgnoredLine(line)) continue
      for (const value of sorted) {
        if (!line.includes(value)) continue
        failures.push(`${name}:${i + 1}: hardcoded runner label "${value}"`)
        break
      }
    }
  }

  if (failures.length > 0) {
    console.error('Hardcoded runner labels found (use env.RN_* from runner-names action):\n')
    for (const failure of failures) {
      console.error(`  ${failure}`)
    }
    process.exit(1)
  }

  console.log('All workflow runner labels reference env.RN_* constants.')
}

main()
