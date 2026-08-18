'use strict'

// Node unit tests for the addon inventory (addons.js) and the contract it has
// with the SDK whose consumer it stands in for.
// Run with: npm run test:unit  (node --test)

const { test } = require('node:test')
const assert = require('node:assert')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const { ADDONS, allNames, pluginsOf, withPlugins } = require('../addons.js')

const SDK_DIR = join(__dirname, '..', '..', 'sdk')
const SDK_MANIFEST = join(SDK_DIR, 'package.json')
const BUNDLE_CONSTANTS = join(SDK_DIR, 'commands', 'bundle', 'constants.ts')
const BUILTIN_PLUGIN_RE = /^\s*'([\w-]+)':\s*\{\s*exportName/gm
const MIN_PARSED_BUILTINS = 5

function sdkDependencies () {
  return JSON.parse(readFileSync(SDK_MANIFEST, 'utf8')).dependencies || {}
}

function builtinPlugins () {
  const source = readFileSync(BUNDLE_CONSTANTS, 'utf8')
  return [...source.matchAll(BUILTIN_PLUGIN_RE)].map(match => match[1])
}

function assertSdkShipsAddon (deps, name) {
  assert.ok(
    deps[ADDONS[name].specifier],
    `${ADDONS[name].specifier} (addons.js "${name}") is no longer a dependency of @qvac/sdk -- drop the entry, or repoint it at whatever the SDK replaced it with`
  )
}

function assertPluginIsBuiltin (builtins, name, plugin) {
  assert.ok(
    builtins.includes(plugin),
    `plugin "${plugin}" of addons.js "${name}" is not an SDK built-in -- check BUILTIN_PLUGINS in packages/sdk/commands/bundle/constants.ts`
  )
}

function assertPluginsAreBuiltin (builtins, name) {
  pluginsOf(name).forEach(plugin => assertPluginIsBuiltin(builtins, name, plugin))
}

function assertSpecifierMatchesName (name) {
  assert.strictEqual(ADDONS[name].specifier, `@qvac/${name}`)
}

// The co-load smoke only proves something if it loads the addons the SDK really
// ships. When the SDK replaced @qvac/transcription-parakeet with @qvac/asr-ggml,
// this inventory kept installing the retired package -- whose last publish
// predated the fix for the very abort the smoke then reported -- while never
// loading the addon the SDK now dlopens. Fail on that drift instead of shipping
// a green run over the wrong addon set.
test('every co-loaded addon is one the SDK still ships', () => {
  const deps = sdkDependencies()
  allNames().forEach(name => assertSdkShipsAddon(deps, name))
})

test('every declared plugin is a real SDK built-in plugin', () => {
  const builtins = builtinPlugins()
  assert.ok(
    builtins.length >= MIN_PARSED_BUILTINS,
    `parsed only ${builtins.length} built-in plugins from packages/sdk/commands/bundle/constants.ts -- BUILTIN_PLUGIN_RE no longer matches how that file is formatted`
  )
  allNames().forEach(name => assertPluginsAreBuiltin(builtins, name))
})

// coload-smoke.yml installs and overlays `@qvac/<shortname>` rather than reading
// `specifier`, so an entry that breaks the convention would install one package
// and overlay another.
test('every short name maps to its own @qvac package', () => {
  allNames().forEach(assertSpecifierMatchesName)
})

test('asr-ggml backs both transcription plugins', () => {
  assert.deepStrictEqual(
    pluginsOf('asr-ggml'),
    ['parakeet-transcription', 'whispercpp-transcription']
  )
})

// One addon can back several plugins, so a combo's plugin count overstates how
// many addons it co-loads. Anything gating on "enough addons to co-load" has to
// count addons.
test('plugin count is not addon count', () => {
  const pair = ['asr-ggml', 'bci-whispercpp']
  assert.strictEqual(pair.flatMap(pluginsOf).length, 2)
  assert.strictEqual(withPlugins(pair).length, 1)
})

test('withPlugins drops addons that expose no SDK plugin', () => {
  assert.deepStrictEqual(withPlugins(['ocr-ggml', 'tts-ggml']), ['tts-ggml'])
  assert.deepStrictEqual(pluginsOf('ocr-ggml'), [])
})
