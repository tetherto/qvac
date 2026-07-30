#!/usr/bin/env node
/**
 * One-shot codemod: replace inline fork-approval job blocks with the reusable
 * workflow caller (reusable-fork-approval.yml).
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const workflowsDir = join(root, '.github/workflows')

const INLINE_BLOCK_RE =
  /  fork-approval:\n    name: Fork approval gate\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    permissions: \{\}\n    environment: \$\{\{ github\.event_name == 'pull_request_target' && github\.event\.pull_request\.head\.repo\.full_name != github\.repository && 'fork-ci' \|\| '' \}\}\n    steps:\n      - name: Record fork-ci approval on head SHA\n        if: github\.event_name == 'pull_request_target' && github\.event\.pull_request\.head\.repo\.full_name != github\.repository\n        env:\n          GH_TOKEN: \$\{\{ secrets\.PAT_TOKEN \}\}\n          HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n          REPO: \$\{\{ github\.repository \}\}\n        run: \|\n          set -euo pipefail\n          gh api "repos\/\$\{REPO\}\/statuses\/\$\{HEAD_SHA\}" \\\n            -f state=success \\\n            -f context=qvac\/fork-verified \\\n            -f description="fork-ci environment approved for this commit"\n      - name: Approved\n        run: echo "fork PR authorised to run privileged jobs"\n/g

const REPLACEMENT = `  fork-approval:
    uses: ./.github/workflows/reusable-fork-approval.yml
    secrets: inherit
`

let changed = 0
for (const name of readdirSync(workflowsDir)) {
  if (!/\.ya?ml$/.test(name) || name === 'reusable-fork-approval.yml') continue
  const path = join(workflowsDir, name)
  const source = readFileSync(path, 'utf8')
  if (!source.includes('fork-approval:')) continue
  if (!INLINE_BLOCK_RE.test(source)) {
    if (source.includes('reusable-fork-approval.yml')) continue
    console.error(`skip (no matching inline block): ${name}`)
    continue
  }
  INLINE_BLOCK_RE.lastIndex = 0
  const next = source.replace(INLINE_BLOCK_RE, REPLACEMENT)
  writeFileSync(path, next)
  changed++
  console.log(`patched: ${name}`)
}

console.log(`done: ${changed} workflow(s)`)
