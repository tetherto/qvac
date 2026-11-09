import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  autoModel,
  defaults,
  defaultPlugins,
  delegateSlots,
  resolveModel
} from '../../dist/lib/runtime/defaults.js'
import { projectRoot, workFolder } from '../../dist/lib/runtime/project.js'

const GIB = 1024 ** 3
const ids = (plugins) => plugins.map((p) => p.id)

test('projectRoot finds the nearest marked ancestor, never home or /', (t) => {
  const home = scratch(t)
  const repo = path.join(home, 'repo')
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'Cargo.toml'), '')
  fs.writeFileSync(path.join(home, 'package.json'), '{}')

  assert.equal(projectRoot(path.join(repo, 'src', 'deep'), fs, { home }), repo)
  assert.equal(projectRoot(repo, fs, { home }), repo)
  assert.equal(projectRoot(home, fs, { home }), null, 'a manifest in home is not a project')
  assert.equal(projectRoot('/', { existsSync: () => true }), null, '/ never counts')
})

test('auto picks the model the memory can hold', () => {
  assert.equal(autoModel(32 * GIB), 'Qwen3.5-9B-Q4_K_M')
  assert.equal(autoModel(16 * GIB), 'Qwen3.5-9B-Q4_K_M')
  assert.equal(autoModel(12 * GIB), 'Qwen3.5-4B-Q4_K_M')
  assert.equal(autoModel(8 * GIB), 'Qwen3.5-4B-Q4_K_M')
  assert.equal(autoModel(4 * GIB), 'Qwen3.5-2B-Q4_K_M')

  assert.equal(resolveModel('auto', 4 * GIB), 'Qwen3.5-2B-Q4_K_M')
  assert.equal(resolveModel('Qwen3.5-4B-Q4_K_M', 64 * GIB), 'Qwen3.5-4B-Q4_K_M')
})

test('in a project: the folder, a coding agent, 40 rounds and a confined shell', (t) => {
  const { root, home } = project(t)
  const d = defaults({ cwd: root, platform: 'darwin', totalMemoryBytes: 16 * GIB, home })

  assert.deepEqual(d.core.folders, [{ path: root, write: true }])
  assert.equal(d.harness.maxToolRounds, 40)
  assert.match(d.core.agent.instructions, /update_plan/)
  assert.match(d.core.agent.instructions, /edit_file/)
  assert.ok(d.core.agent.instructions.split('\n').length <= 25)
  assert.equal(d.core.agent.reasoning, 'enabled')
  assert.deepEqual(ids(d.harness.plugins), ['coding', 'sandbox-macos', 'lsp'])
  assert.equal(d.harness.plugins.find((p) => p.id === 'lsp').optional, true)
  assert.deepEqual(d.core.agent.disabledToolsets, ['exec'], 'one way to run commands: the shell')
  const windows = defaults({ cwd: root, platform: 'win32', totalMemoryBytes: 16 * GIB, home })
  assert.equal(windows.core.agent.disabledToolsets, undefined, 'no coding shell, so exec stays')
})

test('a smaller model does not get reasoning turned on', (t) => {
  const { root, home } = project(t)

  const small = defaults({ cwd: root, platform: 'darwin', totalMemoryBytes: 8 * GIB, home })
  assert.equal(small.core.agent.reasoning, undefined)

  const named = defaults({
    cwd: root,
    platform: 'darwin',
    totalMemoryBytes: 8 * GIB,
    home,
    model: 'Qwen3.5-9B-Q4_K_M'
  })
  assert.equal(named.core.agent.reasoning, 'enabled', 'the configured model decides, not memory')
})

test('the project policy writes the root only and reads a named list', (t) => {
  const { root, home } = project(t)
  for (const dir of ['.cargo', '.nvm', '.ssh', '.aws']) {
    fs.mkdirSync(path.join(home, dir))
  }

  fs.writeFileSync(path.join(home, '.gitconfig'), '')

  const { policy } = defaults({
    cwd: root,
    platform: 'darwin',
    totalMemoryBytes: 8 * GIB,
    home,
    developerDir: '/Applications/Xcode.app/Contents/Developer',
    exists: (p) => p.startsWith(home) && fs.existsSync(p)
  }).harness

  assert.deepEqual(policy.files.write, [root])
  assert.ok(Array.isArray(policy.files.read))
  assert.equal(policy.files.read[0], root)
  for (const p of ['.cargo', '.nvm', '.gitconfig']) {
    assert.ok(policy.files.read.includes(path.join(home, p)), p)
  }

  assert.deepEqual(
    policy.files.read.filter((p) => /\.ssh|\.aws|\.rustup/.test(p)),
    [],
    'never keys or cloud creds, and only what exists'
  )
  assert.deepEqual(policy.network, { mode: 'on' }, 'the network is open until a config limits it')
})

test('a folder with no marker is the project, but never /, home or above home', (t) => {
  const home = path.join(scratch(t), 'me')
  const loose = path.join(home, 'notes')
  fs.mkdirSync(loose, { recursive: true })
  const none = { existsSync: () => false }

  assert.equal(workFolder(loose, none, { home }), loose)
  assert.equal(workFolder('/app', none, { home }), '/app', 'a container workdir is the project')
  assert.equal(workFolder(home, none, { home }), null)
  assert.equal(workFolder(path.dirname(home), none, { home }), null, 'a folder holding home')
  assert.equal(workFolder('/', none, { home }), null)

  const d = defaults({ cwd: loose, platform: 'linux', totalMemoryBytes: 16 * GIB, home })
  assert.deepEqual(d.core.folders, [{ path: loose, write: true }], 'and gets the coding setup')
  assert.equal(d.harness.maxToolRounds, 40)
})

test('outside a project: no folders, 20 rounds, stock agent, no plugins', (t) => {
  const home = scratch(t)
  const d = defaults({ cwd: home, platform: 'darwin', totalMemoryBytes: 16 * GIB, home })

  assert.equal(d.core.folders, undefined)
  assert.equal(d.core.agent, undefined)
  assert.equal(d.harness.maxToolRounds, 20)
  assert.equal(d.harness.plugins, undefined)
  assert.equal(d.harness.policy, undefined)
})

test('each platform gets its own sandbox; Windows gets no coding shell', () => {
  assert.deepEqual(ids(defaultPlugins('darwin')), ['coding', 'sandbox-macos', 'lsp'])
  assert.deepEqual(ids(defaultPlugins('linux')), ['coding', 'sandbox-linux', 'lsp'])
  assert.deepEqual(ids(defaultPlugins('win32')), ['sandbox-windows', 'lsp'])
})

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-defaults-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function project(t) {
  const home = scratch(t)
  const root = path.join(home, 'app')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  return { root, home }
}

test('local subagents run as many at once as memory allows', () => {
  const GIB = 1024 ** 3
  assert.equal(delegateSlots(8 * GIB), 1)
  assert.equal(delegateSlots(16 * GIB), 2)
  assert.equal(delegateSlots(64 * GIB), 3)
})
