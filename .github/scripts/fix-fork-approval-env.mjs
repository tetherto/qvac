#!/usr/bin/env node
/**
 * One-shot: pipe fork-approval status metadata through env: instead of run: interpolation.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const workflowsDir = join(root, '.github/workflows')

const OLD = `        env:
          GH_TOKEN: \${{ secrets.PAT_TOKEN }}
        run: |
          set -euo pipefail
          sha="\${{ github.event.pull_request.head.sha }}"
          gh api "repos/\${{ github.repository }}/statuses/\${sha}" \\
            -f state=success \\
            -f context=qvac/fork-verified \\
            -f description="fork-ci environment approved for this commit"`

const NEW = `        env:
          GH_TOKEN: \${{ secrets.PAT_TOKEN }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          REPO: \${{ github.repository }}
        run: |
          set -euo pipefail
          gh api "repos/\${REPO}/statuses/\${HEAD_SHA}" \\
            -f state=success \\
            -f context=qvac/fork-verified \\
            -f description="fork-ci environment approved for this commit"`

let changed = 0
for (const name of readdirSync(workflowsDir)) {
  if (!/\.ya?ml$/.test(name)) continue
  const path = join(workflowsDir, name)
  const source = readFileSync(path, 'utf8')
  if (!source.includes(OLD)) continue
  writeFileSync(path, source.replaceAll(OLD, NEW))
  changed++
  console.log(`updated ${name}`)
}

if (changed === 0) {
  console.log('no files matched (already fixed?)')
}
