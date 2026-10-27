import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BUILT_IN_PLUGINS, PLUGIN_CATALOG } from '../../dist/lib/runtime/plugin-catalog.js'
import {
  emptyPluginState,
  readPluginState,
  resolvePlugins,
  resolveEnabled,
  setEnabled,
  writePluginState
} from '../../dist/lib/runtime/plugin-state.js'
import { pluginsScreen } from '../../dist/product/plugins-screen.js'
import { fileURLToPath } from 'node:url'

const ids = (entries) => entries.map((e) => e.id)
const state = (...enabled) => ({ ...emptyPluginState(), enabled })

test('catalog entries are unique, importable specifiers, and never built in', () => {
  const all = [...PLUGIN_CATALOG, ...BUILT_IN_PLUGINS].map((e) => e.id)
  assert.equal(new Set(all).size, all.length)
  // resolving through the harness's exports proves each entry is a name it offers
  for (const entry of PLUGIN_CATALOG) {
    const file = fileURLToPath(import.meta.resolve(entry.use))
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`export class ${entry.export}\\b`))
  }
})

test('coding brings the platform sandbox first', () => {
  assert.deepEqual(ids(resolveEnabled(state('coding'), PLUGIN_CATALOG, 'darwin')), [
    'sandbox-macos',
    'coding'
  ])
  assert.deepEqual(ids(resolveEnabled(state('coding'), PLUGIN_CATALOG, 'linux')), [
    'sandbox-linux',
    'coding'
  ])
  const { entries, skipped } = resolvePlugins(state('coding'), PLUGIN_CATALOG, 'win32')
  assert.deepEqual(entries, [])
  assert.match(skipped[0].reason, /win32/)
  const [sandbox, coding] = resolveEnabled(state('coding'), PLUGIN_CATALOG, 'darwin')
  assert.equal(sandbox.auto, true)
  assert.deepEqual(ids(resolveEnabled(state('coding', 'egress-proxy'), PLUGIN_CATALOG, 'darwin')), [
    'egress-proxy',
    'sandbox-macos',
    'coding'
  ])
  assert.equal(coding.auto, false)
})

test('code-mode brings quickjs; explicit deps are not auto and not repeated', () => {
  assert.deepEqual(ids(resolveEnabled(state('code-mode'), PLUGIN_CATALOG, 'linux')), [
    'quickjs',
    'code-mode'
  ])
  const both = resolveEnabled(state('quickjs', 'code-mode', 'lsp'), PLUGIN_CATALOG, 'linux')
  assert.deepEqual(ids(both), ['quickjs', 'code-mode', 'lsp'])
  assert.equal(both[0].auto, false)
})

test('a need a built-in serves is satisfied; platform-only plugins are skipped elsewhere', () => {
  assert.deepEqual(ids(resolveEnabled(state('language-hint'), PLUGIN_CATALOG, 'darwin')), [
    'language-hint'
  ])
  const { entries, skipped } = resolvePlugins(
    state('sandbox-linux', 'nope', 'egress-proxy'),
    PLUGIN_CATALOG,
    'darwin'
  )
  assert.deepEqual(ids(entries), ['egress-proxy'])
  assert.deepEqual(ids(skipped), ['sandbox-linux', 'nope'])
})

test('plugin state round-trips through a data dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-plugins-'))
  try {
    assert.deepEqual(readPluginState(dir, fs), emptyPluginState())
    const saved = writePluginState(
      dir,
      {
        enabled: ['lsp', 'lsp'],
        mcp: { servers: [{ name: 'docs', url: 'https://example.com/mcp' }] }
      },
      fs
    )
    assert.deepEqual(saved.enabled, ['lsp'])
    assert.deepEqual(readPluginState(dir, fs), saved)
    assert.deepEqual(setEnabled(saved, 'lsp', false).enabled, [])
    fs.writeFileSync(path.join(dir, 'plugins.json'), '{nope')
    assert.throws(() => readPluginState(dir, fs), SyntaxError)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function fakeCtx(initial, status, extra = {}) {
  let saved = { ...emptyPluginState(), ...initial }
  const restarts = []
  return {
    restarts,
    get saved() {
      return saved
    },
    options: {
      platform: 'darwin',
      readHostStatus: () => status,
      readPluginState: () => structuredClone(saved),
      writePluginState: (next) => (saved = next),
      restartCore: () => Promise.resolve(restarts.push(1)),
      ...extra
    }
  }
}

test('the screen shows desired against live and toggles plugins.json', async () => {
  const status = {
    plugins: [
      { id: 'lsp', name: 'Language servers', state: 'ready', tools: ['lsp'], source: 'catalog' },
      {
        id: 'quickjs',
        name: 'QuickJS',
        state: 'failed',
        error: 'boom',
        tools: [],
        source: 'catalog'
      }
    ],
    builtIn: [{ id: 'weather', name: 'Weather', tools: ['weather_lookup'] }]
  }
  const ctx = fakeCtx({ enabled: ['lsp', 'coding', 'quickjs'] }, status)
  const { rows, note } = pluginsScreen.load(ctx)
  const row = (id) => rows.find((r) => r.id === id)
  assert.deepEqual(row('lsp').badge, { text: 'ready', color: 'green' })
  assert.deepEqual(row('coding').badge, { text: 'restart to apply', color: 'teal' })
  assert.equal(row('sandbox-macos').state, 'off')
  assert.equal(row('sandbox-macos').detail, 'on with Coding')
  assert.deepEqual(row('quickjs').badge, { text: 'failed', color: 'red' })
  assert.deepEqual(row('sandbox-linux').badge, { text: 'not on darwin', color: 'muted' })
  assert.deepEqual(row('builtin:weather').badge, { text: 'built in', color: 'muted' })
  assert.equal(row('builtin:weather').state, undefined)
  assert.ok(note.some((n) => /press r/.test(n)))

  await pluginsScreen.toggle(ctx, row('lsp'))
  assert.deepEqual(ctx.saved.enabled, ['coding', 'quickjs'])
  assert.deepEqual(pluginsScreen.load(ctx).rows.find((r) => r.id === 'lsp').badge, {
    text: 'restart to apply',
    color: 'teal'
  })
  await pluginsScreen.toggle(ctx, { ...row('walkie-talkie'), state: 'off' })
  assert.ok(ctx.saved.enabled.includes('walkie-talkie'))
  await assert.rejects(pluginsScreen.toggle(ctx, row('sandbox-linux')), /not available on darwin/)

  const detail = pluginsScreen.open(ctx, row('quickjs'))
  assert.ok(detail.lines.includes('Error: boom'))
  assert.ok(
    pluginsScreen.open(ctx, row('coding')).lines.some((l) => l === 'Needs: sandbox (macOS sandbox)')
  )

  await pluginsScreen.actions.find((a) => a.key === 'r').run(ctx)
  assert.equal(ctx.restarts.length, 1)
  const { prompt } = pluginsScreen.actions.find((a) => a.key === 'm').run(ctx)
  await prompt.submit('docs https://example.com/mcp')
  assert.deepEqual(ctx.saved.mcp.servers, [{ name: 'docs', url: 'https://example.com/mcp' }])
  await assert.rejects(prompt.submit('Bad name'), /Name/)
})

test('the screen degrades without app hooks', async () => {
  const ctx = { options: { platform: 'linux' } }
  const { rows, note } = pluginsScreen.load(ctx)
  assert.ok(rows.length > PLUGIN_CATALOG.length)
  assert.ok(note.some((n) => /not available in this build/.test(n)))
  await assert.rejects(
    pluginsScreen.toggle(
      ctx,
      rows.find((r) => r.id === 'lsp')
    ),
    /cannot save/
  )
  await assert.rejects(pluginsScreen.actions[0].run(ctx), /Restart QVAC/)
})

test('a plugin qvac.config lists is a row of its own, with its tools, state and error', async () => {
  const ctx = {
    options: {
      platform: 'darwin',
      readPluginState: () => emptyPluginState(),
      readHostStatus: () => ({
        plugins: [
          {
            id: 'dice-roller',
            name: 'dice-roller',
            state: 'ready',
            tools: ['roll_dice'],
            source: 'config'
          },
          { id: 'broken', state: 'failed', error: 'no setup()', tools: [], source: 'config' }
        ]
      })
    }
  }
  const { rows } = pluginsScreen.load(ctx)
  const dice = rows.find((r) => r.id === 'config:dice-roller')
  assert.equal(dice.detail, 'roll_dice')
  assert.deepEqual(dice.badge, { text: 'ready', color: 'green' })
  assert.match(pluginsScreen.open(ctx, { id: 'config:broken' }).lines.join('\n'), /no setup\(\)/)
  await assert.rejects(() => pluginsScreen.toggle(ctx, dice), /listed in qvac.config/)
})
