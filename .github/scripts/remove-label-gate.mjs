#!/usr/bin/env node
/**
 * One-shot codemod: retire label-gate from workflow YAML.
 * - Removes the label-gate job block
 * - Strips label-gate from needs: arrays
 * - Removes label-gate.outputs.authorised conditions from if:
 * - Updates fork-approval comment (drops migration wording)
 * - Adds qvac/fork-verified commit status to fork-approval (bridges pull_request consumers)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const workflowsDir = join(root, '.github/workflows')

const FORK_APPROVAL_STATUS_STEP = `      - name: Record fork-ci approval on head SHA
        if: github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name != github.repository
        env:
          GH_TOKEN: \${{ secrets.PAT_TOKEN }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          REPO: \${{ github.repository }}
        run: |
          set -euo pipefail
          gh api "repos/\${REPO}/statuses/\${HEAD_SHA}" \\
            -f state=success \\
            -f context=qvac/fork-verified \\
            -f description="fork-ci environment approved for this commit"
      - name: Approved
        run: echo "fork PR authorised to run privileged jobs"`

function removeLabelGateJob(source) {
  const lines = source.split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    if (/^  label-gate:\s*$/.test(lines[i])) {
      i++
      while (i < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
        i++
      }
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join('\n')
}

function stripLabelGateNeeds(source) {
  return source
    .replace(/\n\s*- label-gate\n/g, '\n')
    .replace(/,\s*label-gate\b/g, '')
    .replace(/\blabel-gate,\s*/g, '')
    .replace(/needs:\s*\[label-gate\]\s*\n/g, 'needs: []\n')
}

function stripLabelGateIf(source) {
  let next = source
  const patterns = [
    [/needs\.label-gate\.outputs\.authorised == 'true' &&\s*/g, ''],
    [/&&\s*needs\.label-gate\.outputs\.authorised == 'true'/g, ''],
    [/if:\s*needs\.label-gate\.outputs\.authorised == 'true'\s*\n/g, ''],
    [
      /if:\s*\n\s*needs\.label-gate\.outputs\.authorised == 'true'\s*\n/g,
      '',
    ],
  ]
  for (const [re, rep] of patterns) {
    next = next.replace(re, rep)
  }
  return next
}

function patchForkApproval(source) {
  let next = source
  next = next.replace(
    /# Runs ALONGSIDE the SHA-bound label-gate during migration\.\n/g,
    '# Records qvac/fork-verified on the head SHA after fork-ci approval (bridges pull_request self-hosted jobs).\n',
  )
  if (!next.includes('name: Record fork-ci approval on head SHA')) {
    next = next.replace(
      /(\n  fork-approval:[\s\S]*?\n    steps:\n)(      - name: Approved\n        run: echo "fork PR authorised to run privileged jobs")/,
      `$1${FORK_APPROVAL_STATUS_STEP}`,
    )
  }
  return next
}

function processFile(path) {
  let source = readFileSync(path, 'utf8')
  if (!source.includes('label-gate') && !source.includes('fork-approval:')) {
    return false
  }
  if (!source.includes('label-gate')) {
    const patched = patchForkApproval(source)
    if (patched !== source) {
      writeFileSync(path, patched.endsWith('\n') ? patched : `${patched}\n`)
      return true
    }
    return false
  }
  let next = source
  next = removeLabelGateJob(next)
  next = stripLabelGateNeeds(next)
  next = stripLabelGateIf(next)
  next = patchForkApproval(next)
  if (!next.endsWith('\n')) next += '\n'
  writeFileSync(path, next)
  return true
}

const files = readdirSync(workflowsDir).filter((n) => /\.ya?ml$/.test(n))
let changed = 0
for (const name of files) {
  if (processFile(join(workflowsDir, name))) changed++
}
console.log(`Updated ${changed} workflow file(s)`)
