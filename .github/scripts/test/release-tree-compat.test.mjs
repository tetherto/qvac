import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// pull_request_target runs the default branch's workflows against a release-*
// tree, so steps that call files added on the default branch must still pass
// on a tree cut before them.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CONFIGURATOR = '.github/scripts/configure-cpp-build.mjs'

function step(file, name) {
  const source = readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n')
  const block = source.split('\n      - ').find((text) => text.startsWith(`name: ${name}\n`))
  assert.ok(block, `${file} has a "${name}" step`)
  return block
}

function runBody(block) {
  const lines = block.split('\n')
  const start = lines.findIndex((line) => line === '        run: |')
  assert.notEqual(start, -1, 'step has a multi-line run block')
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break
    body.push(line.slice(10))
  }
  return body.join('\n')
}

// Runs a step body in a fresh tree, with the named commands stubbed to log
// their arguments instead of running.
function runInTree(body, files, stubs) {
  const directory = mkdtempSync(join(tmpdir(), 'release-tree-'))
  try {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), contents)
    }
    const prelude = stubs.map((name) => `${name}() { echo "${name} $*" >> calls.log; }`).join('\n')
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `${prelude}\n${body}`], {
      cwd: directory,
      encoding: 'utf8',
    })
    let calls = ''
    try {
      calls = readFileSync(join(directory, 'calls.log'), 'utf8')
    } catch {}
    return { ...result, calls }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const file of ['.github/workflows/integration-test-asr-ggml.yml', '.github/workflows/integration-test-audiogen-ggml.yml']) {
  test(`${file} stages the platform package only when the tree defines link:platform`, () => {
    const body = runBody(step(file, 'Stage the platform package'))
    const without = runInTree(body, { 'package.json': JSON.stringify({ scripts: {} }) }, ['npm'])
    assert.equal(without.status, 0, without.stderr)
    assert.equal(without.calls, '')
    const withScript = runInTree(body, { 'package.json': JSON.stringify({ scripts: { 'link:platform': 'true' } }) }, ['npm'])
    assert.equal(withScript.status, 0, withScript.stderr)
    assert.equal(withScript.calls, 'npm run link:platform\n')
  })
}

for (const file of ['.github/workflows/cpp-tests-nx.yml', '.github/workflows/cpp-test-coverage-audiogen-ggml.yml']) {
  test(`${file} takes the default branch's C++ build configurator when the tree has none`, () => {
    const checkout = step(file, 'Checkout C++ build configurator (default branch)')
    assert.match(checkout, /if: .*hashFiles\('\.github\/scripts\/configure-cpp-build\.mjs'\) == ''/)
    assert.match(checkout, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/)
    assert.match(checkout, /sparse-checkout: \.github\/scripts\/configure-cpp-build\.mjs/)
    assert.match(checkout, /persist-credentials: false/)
    assert.match(checkout, /path: \.ci-default-branch/)

    const body = runBody(step(file, 'Configure C++ build resources'))
    const old = runInTree(body, {}, ['node'])
    assert.equal(old.status, 0, old.stderr)
    assert.equal(old.calls, `node .ci-default-branch/${CONFIGURATOR}\n`)
    const current = runInTree(body, { [CONFIGURATOR]: '' }, ['node'])
    assert.equal(current.status, 0, current.stderr)
    assert.equal(current.calls, `node ${CONFIGURATOR}\n`)
  })
}

test('reusable-prebuilds keys prebuild reuse on the build config as well as the native tree', () => {
  const file = '.github/workflows/reusable-prebuilds.yml'
  const body = runBody(step(file, 'Key the reuse marker on the build config'))
  const keyFor = (inputs) => {
    const directory = mkdtempSync(join(tmpdir(), 'reuse-key-'))
    try {
      const output = join(directory, 'output')
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', body], {
        encoding: 'utf8',
        env: { ...process.env, NATIVE_HASH: 'abc123', BUILD_INPUTS: JSON.stringify(inputs), GITHUB_OUTPUT: output },
      })
      assert.equal(result.status, 0, result.stderr)
      return readFileSync(output, 'utf8').match(/^reuse_key=(.+)$/m)[1]
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  const release = { workdir: 'packages/tts-ggml', 'include-cuda': false, 'platform-cmake-defines': '', ref: 'aaa', repository: 'tetherto/qvac' }
  const key = keyFor(release)
  assert.match(key, /^abc123-[0-9a-f]{16}$/)
  assert.equal(keyFor({ ...release, ref: 'bbb', 'reuse-workflow-file': 'on-pr-nx.yml' }), key, 'a new head SHA alone keeps the key')
  assert.notEqual(
    keyFor({ ...release, 'include-cuda': true, 'platform-cmake-defines': 'linux-x64: -D ENABLE_CUDA=ON' }),
    key,
    'the default branch CUDA config gets its own key',
  )

  const source = readFileSync(join(root, file), 'utf8')
  assert.match(step(file, 'Reuse prior prebuilds (no native change)'), /native-hash: \$\{\{ steps\.key\.outputs\.reuse_key \}\}/)
  assert.match(step(file, 'Save prebuild reuse marker'), /native-hash: \$\{\{ needs\.detect-reuse\.outputs\.reuse_key \}\}/)
  assert.match(source, /reuse_key: \$\{\{ steps\.key\.outputs\.reuse_key \}\}/)
})

for (const name of ['Verify Vulkan fallback selection', 'Verify explicit Vulkan override with CUDA visible']) {
  test(`integration-test-vla.yml "${name}" skips a tree without the backend-selection test`, () => {
    const body = runBody(step('.github/workflows/integration-test-vla.yml', name))
    const old = runInTree(body, {}, ['npm', 'bare'])
    assert.equal(old.status, 0, old.stderr)
    assert.match(old.stdout, /::notice::/)
    assert.equal(old.calls, '')
    const current = runInTree(body, { 'test/integration/backend-selection.test.js': '' }, ['npm', 'bare'])
    assert.equal(current.status, 0, current.stderr)
    assert.match(current.calls, /^bare test\/integration\/backend-selection\.test\.js --exit$/m)
  })
}
