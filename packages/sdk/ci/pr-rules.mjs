#!/usr/bin/env node
// The SDK pod's PR title and description rules (validator.cjs --type=pr), for a pull request that changes a path
// .github/teams/sdk.json owns. Run by pr-checks.yml's pod-rules job, which also runs on edits.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const { BASE_SHA, HEAD_SHA, PR_TITLE = '', PR_BODY = '' } = process.env
const owned = JSON.parse(readFileSync(`${root}.github/teams/sdk.json`, 'utf8')).ownedPaths
const changed = execFileSync('git', ['diff', '--name-only', `${BASE_SHA}...${HEAD_SHA}`], {
  cwd: root,
  encoding: 'utf8'
})
  .split('\n')
  .filter(Boolean)
const hits = changed.filter((f) => owned.some((p) => f.startsWith(p)))
if (!hits.length) {
  console.log('No SDK pod path changed; the PR rules do not apply.')
  process.exit(0)
}
console.log(`SDK pod paths changed (${hits.length}), validating the title and description.`)
const validator = fileURLToPath(new URL('validator.cjs', import.meta.url))
try {
  execFileSync('node', [validator, '--type=pr', `--title=${PR_TITLE}`, `--body=${PR_BODY}`], {
    stdio: 'inherit'
  })
} catch (e) {
  process.exit(e.status ?? 1)
}
