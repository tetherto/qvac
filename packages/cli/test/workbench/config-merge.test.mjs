import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  applyPluginState,
  describeConfig,
  loadConfig,
  mergeConfig
} from '../../dist/lib/runtime/config.js'
import {
  readPluginState,
  setEnabled,
  withConfigPlugins
} from '../../dist/lib/runtime/plugin-state.js'
import { pluginsScreen } from '../../dist/product/plugins-screen.js'

const GIB = 1024 ** 3
const ids = (plugins) => plugins.map((p) => p.id || p.use)

const base = {
  core: {
    model: 'auto',
    folders: [{ path: '/repo', write: true }],
    agent: { reasoning: 'enabled' }
  },
  harness: {
    maxToolRounds: 40,
    plugins: [{ id: 'coding' }, { id: 'lsp', optional: true, options: { a: 1 } }],
    policy: { network: { mode: 'hosts', hosts: ['github.com'] } }
  }
}

test('objects merge with the user winning, and sources say who set each value', () => {
  const { config, sources } = mergeConfig(base, {
    core: { agent: { approvalMode: 'ask' } },
    harness: { maxToolRounds: 12 }
  })

  assert.equal(config.harness.maxToolRounds, 12)
  assert.equal(config.core.agent.reasoning, 'enabled')
  assert.equal(config.core.agent.approvalMode, 'ask')
  assert.equal(sources['harness.maxToolRounds'], 'config')
  assert.equal(sources['core.agent.reasoning'], 'default')
  assert.equal(sources['core.agent.approvalMode'], 'config')
})

test('arrays replace: a user host list and user folders win whole', () => {
  const { config, sources } = mergeConfig(base, {
    core: { folders: [{ path: '/elsewhere', write: false }] },
    harness: { policy: { network: { hosts: ['github.com', 'example.com'] } } }
  })

  assert.deepEqual(config.core.folders, [{ path: '/elsewhere', write: false }])
  assert.deepEqual(config.harness.policy.network.hosts, ['github.com', 'example.com'])
  assert.equal(config.harness.policy.network.mode, 'hosts')
  assert.equal(sources['core.folders'], 'config')
})

test('plugins merge by id or use; enabled false removes a default', () => {
  const { config, sources } = mergeConfig(base, {
    harness: {
      plugins: [
        { id: 'coding', enabled: false },
        { id: 'lsp', options: { b: 2 } },
        { use: './mine.mjs' }
      ]
    }
  })

  assert.deepEqual(ids(config.harness.plugins), ['lsp', './mine.mjs'])
  assert.deepEqual(config.harness.plugins[0], {
    id: 'lsp',
    optional: true,
    options: { a: 1, b: 2 }
  })
  assert.equal(sources['harness.plugins.coding'], 'config')
  assert.equal(sources['harness.plugins../mine.mjs'], 'config')
})

test('defaults false skips the built-ins', () => {
  const { config, sources } = mergeConfig(base, { defaults: false, harness: { maxToolRounds: 5 } })

  assert.deepEqual(config, { harness: { maxToolRounds: 5 } })
  assert.equal(sources['core.model'], undefined)
})

test('plugins.json goes on top: disabled turns a default off, enabled adds one', () => {
  const loaded = mergeConfig(base, {})
  const { config, sources } = applyPluginState(loaded, {
    enabled: ['code-mode'],
    disabled: ['coding']
  })

  assert.deepEqual(ids(config.harness.plugins), ['lsp', 'code-mode'])
  assert.equal(sources['harness.plugins.coding'], 'plugins.json')
  assert.equal(sources['harness.plugins.code-mode'], 'plugins.json')
  assert.equal(sources['harness.plugins.lsp'], 'default')
  assert.ok(describeConfig(config, sources).includes('harness.plugins.coding = off · plugins.json'))
})

test('an older plugins.json with no disabled list still reads', (t) => {
  const dir = scratch(t)
  fs.writeFileSync(path.join(dir, 'plugins.json'), JSON.stringify({ enabled: ['lsp'] }))

  const state = readPluginState(dir, fs)
  assert.deepEqual(state.disabled, [])
  assert.deepEqual(withConfigPlugins(state, [{ id: 'coding' }]).enabled, ['coding', 'lsp'])
})

test('toggling a default off in /plugins remembers it as disabled', async (t) => {
  let state = { enabled: [], disabled: [], options: {}, mcp: { servers: [] } }
  const ctx = {
    options: {
      platform: 'darwin',
      config: { harness: { plugins: [{ id: 'coding' }, { id: 'sandbox-macos' }] } },
      sources: { 'harness.plugins.coding': 'default', 'harness.plugins.sandbox-macos': 'default' },
      readPluginState: () => state,
      writePluginState: (next) => (state = next),
      readHostStatus: () => ({
        plugins: [
          { id: 'coding', state: 'ready', tools: ['shell'] },
          {
            id: 'sandbox-macos',
            state: 'failed',
            error: 'no sandbox-exec',
            shellBlocked: true
          }
        ],
        shell: { blocked: true, reason: 'sandbox-macos: no sandbox-exec' }
      })
    }
  }

  const before = pluginsScreen.load(ctx)
  assert.equal(before.rows.find((r) => r.id === 'coding').state, 'on')
  assert.ok(
    before.note.includes('Runs refused: sandbox unavailable (sandbox-macos: no sandbox-exec)')
  )
  assert.ok(
    pluginsScreen
      .open(ctx, { id: 'sandbox-macos' })
      .lines.includes('Runs refused: sandbox unavailable (sandbox-macos: no sandbox-exec)')
  )

  await pluginsScreen.toggle(ctx, { id: 'coding', state: 'on' })
  assert.deepEqual(state.disabled, ['coding'])
  assert.equal(pluginsScreen.load(ctx).rows.find((r) => r.id === 'coding').state, 'off')
  assert.ok(
    pluginsScreen
      .open(ctx, { id: 'coding' })
      .lines.includes('On in the built-in defaults; turned off here')
  )

  state = setEnabled(state, 'coding', true)
  assert.deepEqual(state.disabled, [])
})

test('loadConfig layers a qvac.config over the project defaults', async (t) => {
  const home = scratch(t)
  const root = path.join(home, 'app')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  fs.writeFileSync(
    path.join(root, 'qvac.config.json'),
    JSON.stringify({
      harness: {
        plugins: [{ id: 'lsp', enabled: false }, { id: 'egress-proxy' }],
        policy: { network: { mode: 'hosts', hosts: ['registry.npmjs.org', 'example.com'] } }
      }
    })
  )

  const { config, sources, configPath } = await loadConfig({
    cwd: root,
    platform: 'darwin',
    totalMemoryBytes: 8 * GIB,
    home
  })

  assert.equal(configPath, path.join(root, 'qvac.config.json'))
  assert.equal(config.core.model, 'Qwen3.5-4B-Q4_K_M')
  assert.deepEqual(config.core.folders, [{ path: root, write: true }])
  assert.deepEqual(ids(config.harness.plugins), ['coding', 'sandbox-macos', 'egress-proxy'])
  assert.deepEqual(config.harness.policy.network, {
    mode: 'hosts',
    hosts: ['registry.npmjs.org', 'example.com']
  })
  assert.equal(sources['harness.policy.network.hosts'], 'config')
  assert.equal(sources['harness.policy.network.mode'], 'config')
  assert.ok(
    describeConfig(config, sources).includes('harness.maxToolRounds = 40 · default'),
    'describeConfig shows the key, value and source'
  )
})

test('a user folder outside the project is covered by the default policy', async (t) => {
  const home = scratch(t)
  const root = path.join(home, 'app')
  const notes = path.join(home, 'notes')
  fs.mkdirSync(root)
  fs.mkdirSync(notes)
  fs.writeFileSync(path.join(root, '.git'), '')
  fs.writeFileSync(
    path.join(root, 'qvac.config.json'),
    JSON.stringify({ core: { folders: [{ path: '../notes', write: true }] } })
  )

  const { config } = await loadConfig({ cwd: root, platform: 'linux', totalMemoryBytes: 0, home })

  assert.deepEqual(config.core.folders, [{ path: notes, write: true }])
  assert.ok(config.harness.policy.files.read.includes(notes))
  assert.deepEqual(config.harness.policy.files.write, [root, notes])
})

test('defaults false in a project leaves only what the file says', async (t) => {
  const home = scratch(t)
  const root = path.join(home, 'app')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'go.mod'), '')
  fs.writeFileSync(
    path.join(root, 'qvac.config.json'),
    JSON.stringify({ defaults: false, core: { model: 'Qwen3.5-2B-Q4_K_M' } })
  )

  const { config } = await loadConfig({ cwd: root, platform: 'darwin', totalMemoryBytes: 0, home })

  assert.equal(config.core.model, 'Qwen3.5-2B-Q4_K_M')
  assert.equal(config.core.folders, undefined)
  assert.deepEqual(config.harness.plugins, [])
  assert.equal(config.harness.policy, undefined)
})

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-merge-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
