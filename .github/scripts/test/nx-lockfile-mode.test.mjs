// nx.json ignores pnpm-lock.yaml for affected selection, and the matrix action
// selects instead exactly the workspace packages whose resolved dependency tree
// changed, plus their workspace dependents (lockfile-selection.mjs). The first
// half alone narrows a shared bump to one package; the second alone changes
// nothing. These tests pin both.
//
// Lockfiles are small synthetic v9 files so the suite needs no git history. The
// importer paths are real workspace directories, because the dependents walk and
// the matrix-readable filter read the real manifests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const script = join(root, '.github/actions/nx-project-matrix/lockfile-selection.mjs')
const action = join(root, '.github/actions/nx-project-matrix/action.yml')
const scratch = mkdtempSync(join(tmpdir(), 'lock-'))

// A minimal pnpm-lock.yaml v9. `edit` mutates the parts a test changes.
function lock(edit = {}) {
  const v = {
    settings: 'autoInstallPeers: true',
    overrides: 'hyper-instrument>bare-v8: ^1.0.1',
    llmFs: '4.7.4',
    llmFabricLink: false,
    ocrOs: '3.6.2',
    fabricPath: '3.1.1',
    rootNx: '23.1.0',
    eventsVersion: '2.5.0',
    eventsIntegrity: 'sha512-EEE',
    orphan: false,
    ...edit,
  }
  return `lockfileVersion: '9.0'

settings:
  ${v.settings}

overrides:
  ${v.overrides}

importers:

  .:
    devDependencies:
      nx:
        specifier: 23.1.0
        version: ${v.rootNx}

  packages/llm-llamacpp:
    dependencies:${v.llmFabricLink ? `
      '@qvac/fabric':
        specifier: ^0.17.0
        version: link:../fabric` : ''}
      bare-fs:
        specifier: ^4.5.1
        version: ${v.llmFs}

  packages/ocr-ggml:
    dependencies:
      bare-os:
        specifier: ^3.0.0
        version: ${v.ocrOs}

  packages/fabric:
    dependencies:
      bare-path:
        specifier: ^3.0.0
        version: ${v.fabricPath}

packages:

  bare-events@${v.eventsVersion}:
    resolution: {integrity: ${v.eventsIntegrity}}

  bare-fs@${v.llmFs}:
    resolution: {integrity: sha512-FS${v.llmFs}}

  bare-os@${v.ocrOs}:
    resolution: {integrity: sha512-OS${v.ocrOs}}

  bare-path@${v.fabricPath}:
    resolution: {integrity: sha512-PATH${v.fabricPath}}

  nx@${v.rootNx}:
    resolution: {integrity: sha512-NX${v.rootNx}}
${v.orphan ? `
  unused@1.0.0:
    resolution: {integrity: sha512-UNUSED}
` : ''}
snapshots:

  bare-events@${v.eventsVersion}: {}

  bare-fs@${v.llmFs}:
    dependencies:
      bare-events: ${v.eventsVersion}

  bare-os@${v.ocrOs}: {}

  bare-path@${v.fabricPath}: {}

  nx@${v.rootNx}: {}
`
}

let n = 0
function select(paths, base, head, wsBase, wsHead) {
  const args = [script, root]
  for (const [a, b] of [[base, head], [wsBase, wsHead]]) {
    if (a === undefined) break
    const pa = join(scratch, `a${n}`)
    const pb = join(scratch, `b${n++}`)
    writeFileSync(pa, a)
    writeFileSync(pb, b)
    args.push(pa, pb)
  }
  const out = execFileSync('node', args, { input: paths.map((p) => `${p}\n`).join('') })
  return JSON.parse(out.toString())
}
const withLock = (edit, extraPaths = []) => select(['pnpm-lock.yaml', ...extraPaths], lock(), lock(edit))

const SIBLING_ADDONS = ['asr-ggml', 'tts-ggml', 'ocr-ggml', 'vla-ggml', 'embed-llamacpp', 'diffusion-cpp']
const FABRIC_CONSUMERS = [
  'classification-ggml',
  'embed-llamacpp',
  'llm-llamacpp',
  'model-fit',
  'ocr-ggml',
  'translation-nmtcpp',
  'vla-ggml',
]

test('an addon dependency bump selects that addon, not its siblings', () => {
  const { mode, extra } = withLock({ llmFs: '4.8.0' }, ['packages/llm-llamacpp/package.json'])
  assert.equal(mode, '')
  assert.ok(extra.includes('llm-llamacpp'))
  for (const sibling of SIBLING_ADDONS) {
    assert.ok(!extra.includes(sibling), `${sibling} does not depend on llm-llamacpp but was selected`)
  }
})

test('a shared dependency bump reaches every consumer', () => {
  const { mode, extra } = withLock({ fabricPath: '3.2.0' }, ['packages/fabric/package.json'])
  assert.equal(mode, '')
  for (const consumer of FABRIC_CONSUMERS) {
    assert.ok(extra.includes(consumer), `${consumer} links @qvac/fabric but was not selected`)
  }
})

test('a transitive-only change selects the package that installs it', () => {
  // bare-events is only reached through llm-llamacpp's bare-fs.
  const { mode, extra } = withLock({ eventsVersion: '2.6.0' })
  assert.equal(mode, '')
  assert.ok(extra.includes('llm-llamacpp'))
  assert.ok(!extra.includes('ocr-ggml'), 'ocr-ggml does not install bare-events')
})

test('an integrity-only change counts, even at the same version', () => {
  const { mode, extra } = withLock({ eventsIntegrity: 'sha512-REPUBLISHED' })
  assert.equal(mode, '')
  assert.ok(extra.includes('llm-llamacpp'))
})

test('a new workspace link counts, though it installs nothing external', () => {
  const { mode, extra } = withLock({ llmFabricLink: true }, ['packages/llm-llamacpp/package.json'])
  assert.equal(mode, '')
  assert.ok(extra.includes('llm-llamacpp'))
})

test("the root importer, settings and overrides keep today's behaviour", () => {
  assert.equal(withLock({ rootNx: '23.2.0' }).mode, 'all', 'root devDependencies are tooling for everything')
  // Paired with a real bump, so the unattributable-change fallback can't be what
  // returns "all": without the settings/overrides check these would narrow.
  assert.equal(withLock({ settings: 'autoInstallPeers: false', llmFs: '4.8.0' }).mode, 'all')
  assert.equal(withLock({ overrides: 'bare-path: 3.0.0', llmFs: '4.8.0' }).mode, 'all')
})

test("a lockfile change no importer installs keeps today's behaviour", () => {
  assert.equal(withLock({ orphan: true }).mode, 'all')
})

test("pnpm config and the root manifest keep today's behaviour", () => {
  for (const file of ['package.json', '.npmrc']) {
    assert.equal(select(['pnpm-lock.yaml', file], lock(), lock({ llmFs: '4.8.0' })).mode, 'all', file)
  }
})

// A workspace file of the shape the real one has.
const ws = ({ exclude = [], builds = ['esbuild'] } = {}) => `packages:
  - packages/*

minimumReleaseAgeExclude:
${['@qvac/fabric@0.17.0', ...exclude].map((e) => `  - '${e}'`).join('\n')}

allowBuilds:
${builds.map((b) => `  ${b}: true`).join('\n')}

fetchRetries: 5
`

test('a pnpm-workspace.yaml change the lockfile records still narrows', () => {
  // As in #4733: a release-age exclusion for the fabric version being bumped.
  const paths = ['pnpm-lock.yaml', 'pnpm-workspace.yaml']
  const { mode, extra } = select(paths, lock(), lock({ llmFs: '4.8.0' }), ws(), ws({ exclude: ['@qvac/fabric@0.18.0'] }))
  assert.equal(mode, '')
  assert.ok(extra.includes('llm-llamacpp'))
  assert.ok(!extra.includes('ocr-ggml'))
})

test("a pnpm-workspace.yaml change the lockfile cannot show keeps today's behaviour", () => {
  const paths = ['pnpm-lock.yaml', 'pnpm-workspace.yaml']
  const bump = lock({ llmFs: '4.8.0' })
  assert.equal(select(paths, lock(), bump, ws(), ws({ builds: ['esbuild', 'sharp'] })).mode, 'all', 'allowBuilds')
  assert.equal(select(paths, lock(), bump, ws(), ws().replace('fetchRetries: 5', 'fetchRetries: 2')).mode, 'all', 'fetch setting')
  assert.equal(select(paths, lock(), bump).mode, 'all', 'no workspace revisions supplied')
  assert.equal(select(paths, lock(), bump, ws(), 'x').mode, 'all', 'key removed')
})

test("a lockfile that cannot be read keeps today's behaviour", () => {
  assert.equal(select(['pnpm-lock.yaml']).mode, 'all', 'no revisions supplied')
  assert.equal(select(['pnpm-lock.yaml'], 'not: [a lockfile', lock()).mode, 'all', 'unparseable base')
})

test('without a lockfile change nothing is corrected', () => {
  assert.deepEqual(select(['packages/llm-llamacpp/package.json']), { mode: '', extra: [] })
  assert.deepEqual(select(['packages/ocr-ggml/index.js']), { mode: '', extra: [] })
  assert.deepEqual(select(['']), { mode: '', extra: [] })
  assert.deepEqual(select(['packages/x/pnpm-lock.yaml']), { mode: '', extra: [] })
})

test('selected packages are only ones the matrix loop can read', () => {
  // It reads packages/<name>/project.json and warns when absent.
  const { extra } = withLock({ fabricPath: '3.2.0' })
  assert.ok(!extra.includes('inference'), 'inference has no project.json')
  assert.ok(!extra.some((name) => name.endsWith('-plugin')), 'plugins live outside packages/')
})

test('a path list larger than the pipe buffer is read correctly', () => {
  const filler = Array.from({ length: 6000 }, (_, i) => `packages/llm-llamacpp/src/f${i}.js`)
  assert.equal(select(['pnpm-lock.yaml', ...filler]).mode, 'all')
  assert.ok(
    select([...filler, 'pnpm-lock.yaml'], lock(), lock({ llmFs: '4.8.0' })).extra.includes('llm-llamacpp')
  )
})

test('nx.json ignores the lockfile for affected selection', () => {
  const nx = JSON.parse(readFileSync(join(root, 'nx.json'), 'utf8'))
  assert.deepEqual(
    nx.pluginsConfig?.['@nx/js']?.projectsAffectedByDependencyUpdates,
    [],
    'nx.json must set projectsAffectedByDependencyUpdates to [] — "all" (the ' +
      'default) and "auto" both select every addon on a one-addon dependency bump'
  )
})

test('the matrix action still feeds both lockfile revisions and adds the selection', () => {
  const source = readFileSync(action, 'utf8')
  assert.match(source, /lockfile-selection\.mjs" \. "\$BASE_LOCK" "\$HEAD_LOCK" "\$BASE_WS" "\$HEAD_WS"/,
    'nx-project-matrix no longer passes the base and head lockfiles, so every ' +
      'lockfile change would fall back to selecting everything')
  assert.match(source, /\$DEPENDENTS/, 'nx-project-matrix no longer adds the selection to AFFECTED')
})
