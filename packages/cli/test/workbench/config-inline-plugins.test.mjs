import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { describeConfig, loadConfig } from '../../dist/lib/runtime/config.js'
import { runtimeJson } from '../../dist/lib/runtime/config-json.js'

const bare = createRequire(import.meta.url)('bare-runtime')()
const fixture = new URL('./fixtures/config-inline-plugins.mjs', import.meta.url).pathname
const greeter = new URL('../../docs/plugins/greeter.mjs', import.meta.url).href

const shout = `{
  name: 'shout',
  setup() {
    return { tools: [{ name: 'shout', execute: (args) => args.text.toUpperCase() }] }
  }
}`

test('inline plugins become markers with configPath beside them', async (t) => {
  const { loaded } = await project(t, [
    'new Greeter({ greeting: "Hi" })',
    `{ plugin: ${shout}, read: ['shout'], optional: true }`
  ])
  const json = JSON.parse(runtimeJson(loaded))

  assert.equal(json.configPath, loaded.configPath)
  assert.deepEqual(json.config.harness.plugins, [
    { inline: 1, name: 'greeter' },
    { read: ['shout'], optional: true, inline: 2, name: 'shout' }
  ])
  assert.deepEqual(json.config.tui.extensions, [{ inline: 0, name: 'panel' }])
})

test('an inline plugin merges by its name, so an id entry turns it off', async (t) => {
  const { loaded } = await project(t, ['new Greeter()', "{ id: 'greeter', enabled: false }"])

  assert.deepEqual(loaded.config.harness.plugins, [])
  assert.equal(loaded.sources['harness.plugins.greeter'], 'config')
})

test('qvac config shows an inline plugin as inline', async (t) => {
  const { loaded } = await project(t, [`{ plugin: ${shout}, read: ['shout'] }`])

  assert.ok(
    describeConfig(loaded.config, loaded.sources).includes(
      'harness.plugins.shout = inline · config'
    )
  )
})

test('the worker imports the config and adds its inline plugins', async (t) => {
  const { file } = await project(t, [
    'new Greeter({ greeting: "Hi" })',
    `{ plugin: ${shout}, read: ['shout'] }`
  ])
  const { status, greeting, reads } = boot(file)

  assert.deepEqual(
    status.plugins.map(({ id, state, tools, source }) => ({ id, state, tools, source })),
    [
      { id: 'greeter', state: 'ready', tools: ['greet'], source: 'config' },
      { id: 'shout', state: 'ready', tools: ['shout'], source: 'config' }
    ]
  )
  assert.equal(greeting, 'Hi, Ada!', 'the plugin is the one the config built')
  assert.deepEqual(reads, { greeter: [], shout: ['shout'] })
})

test('a config that only loads in Node fails its inline plugins, not the worker', async (t) => {
  const { file } = await project(t, ['new Greeter()', `{ plugin: ${shout}, optional: true }`], {
    head: "import 'node:path'"
  })
  const [greeter, shouted] = boot(file).status.plugins

  assert.equal(greeter.state, 'failed')
  assert.match(greeter.error, /^qvac\.config did not load under Bare: /)
  assert.equal(shouted.state, 'skipped')
  assert.equal(shouted.error, greeter.error)
})

async function project(t, plugins, { head = '' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-inline-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  fs.writeFileSync(
    path.join(dir, 'qvac.config.mjs'),
    `${head}
import { Greeter } from '${greeter}'
export default {
  defaults: false,
  core: { dataDir: '.' },
  harness: { plugins: [{ id: 'lsp', enabled: false }, ${plugins.join(', ')}] },
  tui: { extensions: [{ name: 'panel', render: () => [] }] }
}
`
  )
  const loaded = await loadConfig({ cwd: dir })
  const file = path.join(dir, 'cli-runtime-config.json')
  fs.writeFileSync(file, runtimeJson(loaded))

  return { loaded, file }
}

function boot(file) {
  fs.chmodSync(bare, 0o755)
  const run = spawnSync(bare, [fixture, file], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)

  return JSON.parse(run.stdout)
}
