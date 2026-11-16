import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// on-pr-nx and Merge Guard run on pull_request_target, so their package
// selection comes from the base branch, where a package the PR deletes still
// exists. Without dropping it, its jobs run in a directory the PR head no
// longer has and both merge guards fail (PR #5775, removing model-fit).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const action = readFileSync(join(root, '.github/actions/nx-project-matrix/action.yml'), 'utf8')
const guard = readFileSync(join(root, '.github/workflows/pr-gate-merge.yml'), 'utf8')

const matrixSelector = action.match(/jq -r '(if \.status == "removed"[^']*)' "\$files"/)?.[1]
const guardSelector = guard.match(/--jq '\.\[\] \| (if \.status == "removed"[^']*)'/)?.[1]
const keepPresent = guard.match(/'(map\(select\(\(if \. == "vla"[^']*)'/)?.[1]

const FILES = [
  { filename: 'packages/gone/package.json', status: 'removed', previous_filename: null },
  { filename: 'packages/gone/src/index.ts', status: 'removed', previous_filename: null },
  { filename: 'packages/elsewhere/package.json', status: 'renamed', previous_filename: 'packages/vla-ggml/package.json' },
  { filename: 'packages/kept/test/old.test.js', status: 'removed', previous_filename: null },
  { filename: 'packages/edited/package.json', status: 'modified', previous_filename: null },
  { filename: 'packages/gone/nested/package.json', status: 'removed', previous_filename: null },
]

function deletedPackages(selector) {
  const paths = execFileSync('jq', ['-r', selector], {
    input: FILES.map((file) => JSON.stringify(file)).join('\n'),
    encoding: 'utf8',
  })
  const dirs = paths.split('\n').filter((path) => /^packages\/[^/]+\/package\.json$/.test(path))
  return [...new Set(dirs.map((path) => path.split('/')[1]))].sort()
}

test('both selections share one deleted-package selector', () => {
  assert.ok(matrixSelector, 'nx-project-matrix no longer derives deleted packages from the PR file statuses')
  assert.ok(guardSelector, 'Merge Guard no longer derives deleted packages from the PR file statuses')
  assert.equal(matrixSelector, guardSelector)
})

test('a removed or renamed-away package.json marks its package deleted, nothing else does', () => {
  assert.deepEqual(deletedPackages(matrixSelector), ['gone', 'vla-ggml'])
})

test('nx-project-matrix subtracts deleted packages after the lockfile dependents are added', () => {
  assert.match(action, /\| cut -d\/ -f2 \| sort -u > "\$\{RUNNER_TEMP\}\/nx-deleted-packages\.txt"/)
  const added = action.indexOf("'. + $extra | unique'")
  const subtracted = action.indexOf("'. - $deleted'")
  const reported = action.indexOf('echo "Affected ($TARGET, transitive): $AFFECTED"')
  assert.ok(added > 0 && subtracted > added && reported > subtracted,
    'deleted packages must be dropped after DEPENDENTS, or the lockfile selection re-adds them')
})

test('Merge Guard drops deleted packages from both its lists, mapping vla to vla-ggml', () => {
  assert.ok(keepPresent, 'Merge Guard lost its keep_present filter')
  const kept = JSON.parse(execFileSync('jq', ['-c', '--argjson', 'deleted', '["asr-ggml","vla-ggml"]', keepPresent], {
    input: '["asr-ggml","fabric","vla","llm-llamacpp"]',
    encoding: 'utf8',
  }))
  assert.deepEqual(kept, ['fabric', 'llm-llamacpp'])
  assert.match(guard, /CHANGED=\$\(echo "\$CHANGES" \| jq -c '[^']*' \| keep_present\)/,
    '`packages` would make verify-prebuilds wait for a status nothing posts')
  assert.match(guard, /SANITY=\$\(keep_present <<< "\$ALL_PACKAGES"\)/,
    'the shared-CI sweep would run sanity-checks in a deleted directory')
})
