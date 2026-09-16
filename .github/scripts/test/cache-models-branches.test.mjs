import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Guards the branch structure of .github/actions/cache-models/action.yml.
//
// Three steps can address the cache and exactly one may run: the trusted
// save, the fork-PR restore, and the keep-alive. Their conditions were edited
// by hand more than once and a mistake there is silent -- a fork reaching the
// save branch, or a keep-alive quietly refreshing the wrong entry.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const ACTION = '.github/actions/cache-models/action.yml'
const src = readFileSync(join(root, ACTION), 'utf8')

function step(name) {
  const i = src.indexOf(`    - name: ${name}`)
  assert.notEqual(i, -1, `step not found: ${name}`)
  const j = src.indexOf('\n    - name: ', i + 1)
  return src.slice(i, j === -1 ? undefined : j)
}

const SAVE = 'Cache test models (restore + save, trusted contexts)'
const FORK = 'Cache test models (restore-only, untrusted contexts)'
test('both cache branches carry restore-keys for partial recovery', () => {
  assert.match(step(SAVE), /restore-keys:/)
  assert.match(step(FORK), /restore-keys:/)
})

test('restore-keys is never suppressed by an empty-string ternary', () => {
  // `A && '' || B` always yields B in GitHub expressions -- '' is falsy. An
  // earlier attempt to suppress a prefix this way shipped as a silent no-op;
  // keep the shape out of the file entirely.
  assert.ok(
    !/restore-keys:\s*\$\{\{[^}]*&&\s*''\s*\|\|/.test(src),
    "restore-keys must not be gated with `&& '' ||`; use a separate step",
  )
})

test('only the trusted branch can save', () => {
  const save = step(SAVE)
  assert.match(save, /uses: actions\/cache@/, 'the save branch is the combined action')
  for (const evt of ['push', 'workflow_dispatch', 'merge_group', 'schedule']) {
    assert.ok(save.includes(`github.event_name == '${evt}'`), `save branch must list ${evt}`)
  }
  assert.ok(
    save.includes('github.event.pull_request.head.repo.full_name == github.repository'),
    'save branch must require a same-repo head',
  )
  // The other branch only ever restores.
  for (const s of [step(FORK)]) {
    assert.match(s, /uses: actions\/cache\/restore@/)
    assert.ok(!/uses: actions\/cache@/.test(s), 'restore steps must not use the saving action')
  }
})

test('the two cache branches are mutually exclusive', () => {
  // The fork branch is the exact negation of the save branch's event list, so
  // exactly one runs whenever the probe missed.
  const fork = step(FORK)
  for (const evt of ['push', 'workflow_dispatch', 'merge_group', 'schedule']) {
    assert.ok(fork.includes(`github.event_name != '${evt}'`), `fork branch must negate ${evt}`)
  }
  assert.ok(fork.includes('github.event.pull_request.head.repo.full_name != github.repository'))
})

test('the cache-hit output considers every branch that can run', () => {
  const out = src.slice(0, src.indexOf('runs:'))
  for (const id of ['steps.cache.outputs.cache-hit', 'steps.cache-restore-only.outputs.cache-hit']) {
    assert.ok(out.includes(id), `cache-hit output must fall through to ${id}`)
  }
  // The probe is compared explicitly because a step that ran and missed emits
  // the string 'false', which is truthy and would short-circuit the chain.
  assert.match(out, /steps\.probe\.outputs\.cache-hit == 'true'/)
})
