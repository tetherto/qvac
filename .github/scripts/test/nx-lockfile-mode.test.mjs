// nx.json ignores pnpm-lock.yaml for affected selection, and the matrix action
// corrects the two cases that leaves wrong (lockfile-selection.mjs). Both halves
// are needed: the first alone narrows a shared dependency bump to the package
// that changed, the second alone changes nothing. These tests pin both.
//
// The decision reads the real workspace manifests, so cases assert what must and
// must not be selected rather than exact lists: a new fabric consumer should not
// break them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = join(root, '.github/actions/nx-project-matrix/lockfile-selection.mjs')
const action = join(root, '.github/actions/nx-project-matrix/action.yml')

const select = (...paths) =>
  JSON.parse(
    execFileSync('node', [script, root], { input: paths.map((p) => `${p}\n`).join('') }).toString()
  )

const FABRIC_CONSUMERS = [
  'classification-ggml',
  'embed-llamacpp',
  'llm-llamacpp',
  'model-fit',
  'ocr-ggml',
  'translation-nmtcpp',
  'vla-ggml',
]
const SIBLING_ADDONS = ['asr-ggml', 'tts-ggml', 'ocr-ggml', 'vla-ggml', 'embed-llamacpp', 'diffusion-cpp']

test('an addon dependency bump selects that addon, not its siblings', () => {
  const { mode, extra } = select('pnpm-lock.yaml', 'packages/llm-llamacpp/package.json')
  assert.equal(mode, '')
  for (const sibling of SIBLING_ADDONS) {
    assert.ok(!extra.includes(sibling), `${sibling} does not depend on llm-llamacpp but was selected`)
  }
})

test('a shared dependency bump still reaches every consumer', () => {
  const { mode, extra } = select('pnpm-lock.yaml', 'packages/fabric/package.json')
  assert.equal(mode, '')
  for (const consumer of FABRIC_CONSUMERS) {
    assert.ok(extra.includes(consumer), `${consumer} links @qvac/fabric but was not selected`)
  }
})

test('dependents are followed transitively', () => {
  // tts-ggml depends on asr-ggml, which depends on decoder-audio.
  assert.ok(select('pnpm-lock.yaml', 'packages/decoder-audio/package.json').extra.includes('tts-ggml'))
})

test("a lockfile change with no workspace manifest keeps today's behaviour", () => {
  assert.equal(select('pnpm-lock.yaml').mode, 'all')
  assert.equal(select('pnpm-lock.yaml', 'packages/ocr-ggml/index.js').mode, 'all')
})

test("the root manifest keeps today's behaviour, even alongside a package bump", () => {
  assert.equal(select('pnpm-lock.yaml', 'package.json').mode, 'all')
  assert.equal(select('pnpm-lock.yaml', 'package.json', 'packages/llm-llamacpp/package.json').mode, 'all')
})

test('only manifests listed by pnpm-workspace.yaml explain a lockfile change', () => {
  assert.equal(select('pnpm-lock.yaml', 'plugins/opencode/package.json').mode, '')
  assert.equal(select('pnpm-lock.yaml', 'docs/website/package.json').mode, 'all')
  assert.equal(select('pnpm-lock.yaml', 'packages/llm-llamacpp/benchmarks/server/package.json').mode, 'all')
})

test('without a lockfile change nothing is corrected', () => {
  assert.deepEqual(select('packages/llm-llamacpp/package.json'), { mode: '', extra: [] })
  assert.deepEqual(select('packages/ocr-ggml/index.js'), { mode: '', extra: [] })
  assert.deepEqual(select(''), { mode: '', extra: [] })
})

test('only the root lockfile counts, not one nested in a package', () => {
  assert.deepEqual(select('packages/x/pnpm-lock.yaml'), { mode: '', extra: [] })
})

test('added dependents are only packages the matrix loop can read', () => {
  // It reads packages/<name>/project.json and warns when absent.
  const { extra } = select('pnpm-lock.yaml', 'packages/fabric/package.json')
  assert.ok(!extra.includes('inference'), 'inference has no project.json')
  assert.ok(!extra.some((name) => name.endsWith('-plugin')), 'plugins live outside packages/')
})

test('a path list larger than the pipe buffer is read correctly', () => {
  const filler = Array.from({ length: 6000 }, (_, i) => `packages/llm-llamacpp/src/f${i}.js`)
  assert.equal(select('pnpm-lock.yaml', ...filler).mode, 'all')
  assert.equal(select('packages/llm-llamacpp/package.json', ...filler, 'pnpm-lock.yaml').mode, '')
})

test('nx.json ignores the lockfile for affected selection', () => {
  const nx = JSON.parse(readFileSync(join(root, 'nx.json'), 'utf8'))
  assert.deepEqual(
    nx.pluginsConfig?.['@nx/js']?.projectsAffectedByDependencyUpdates,
    [],
    'nx.json must set projectsAffectedByDependencyUpdates to [] — "all" (the ' +
      'default) and "auto" both select most of the workspace on a one-line ' +
      'dependency change, because pnpm rewrites shared lockfile entries'
  )
})

test('the matrix action still applies both corrections', () => {
  const source = readFileSync(action, 'utf8')
  assert.match(
    source,
    /lockfile-selection\.mjs/,
    'nx-project-matrix no longer calls lockfile-selection.mjs, so a shared ' +
      'dependency bump would test only the package that changed'
  )
  assert.match(
    source,
    /\$DEPENDENTS/,
    'nx-project-matrix no longer adds the workspace dependents to AFFECTED'
  )
})
