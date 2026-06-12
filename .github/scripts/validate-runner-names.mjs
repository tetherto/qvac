#!/usr/bin/env node
/**
 * Fail when workflow files duplicate runner env blocks or hardcode runner labels.
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

const ENV_MARKER = '# Canonical runner labels — .github/actions/runner-names/runners.yaml'
const RUNNER_NAMES_JOB = 'runner_names'
const REUSABLE_WORKFLOW = './.github/workflows/reusable-runner-names.yml'

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
  if (/^\s*RN_[A-Z0-9_]+:/.test(line)) return true
  if (/^\s*#/.test(line)) return true
  if (/description:/.test(line)) return true
  if (/^\s*-?\s*name:/.test(line)) return true
  if (/GITHUB_STEP_SUMMARY/.test(line)) return true
  if (/needs\.runner_names\.outputs\./.test(line)) return true
  if (/steps\.runner_names\.outputs\./.test(line)) return true
  if (line.includes(REUSABLE_WORKFLOW)) return true
  return false
}

function main () {
  const runnerValues = parseRunnersYaml(fs.readFileSync(runnersYamlPath, 'utf8'))
  const sorted = [...runnerValues].sort((a, b) => b.length - a.length)
  const failures = []

  for (const name of fs.readdirSync(workflowsDir)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue
    if (name === 'reusable-runner-names.yml') continue

    const filePath = path.join(workflowsDir, name)
    const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
    const lines = text.split('\n')

    if (text.includes(ENV_MARKER) || /\n  RN_[A-Z0-9_]+:/.test(text)) {
      failures.push(`${name}: duplicated runner env block (use ${REUSABLE_WORKFLOW})`)
    }

    const usesRunners = text.includes(`needs.${RUNNER_NAMES_JOB}.outputs.`)
    const hasRunnerJob = text.includes(`  ${RUNNER_NAMES_JOB}:`)
    if (usesRunners && !hasRunnerJob) {
      failures.push(`${name}: missing ${RUNNER_NAMES_JOB} reusable workflow job`)
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.includes('env.RN_')) {
        failures.push(`${name}:${i + 1}: use needs.${RUNNER_NAMES_JOB}.outputs.* instead of env.RN_*`)
        continue
      }
      if (isIgnoredLine(line)) continue
      for (const value of sorted) {
        if (!line.includes(value)) continue
        failures.push(`${name}:${i + 1}: hardcoded runner label "${value}"`)
        break
      }
    }
  }

  if (failures.length > 0) {
    console.error('Runner name validation failed:\n')
    for (const failure of failures) {
      console.error(`  ${failure}`)
    }
    process.exit(1)
  }

  console.log('Runner name references are centralized via reusable-runner-names.yml.')
}

main()
