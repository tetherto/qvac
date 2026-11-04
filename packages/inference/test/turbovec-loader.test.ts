import test from 'brittle'
import type { TurboVecIndexProvider } from '@qvac/rag'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import URL from 'bare-url'

// Isolate the optional addons while keeping the plugin's engine imports intact.
async function isolatedProvider(t: { teardown: (fn: () => void) => void }, addon?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-turbovec-loader-'))
  t.teardown(() => fs.rmSync(directory, { recursive: true, force: true }))
  const pluginURL = new URL('../src/plugins/builtin/llamacpp-embedding/plugin.js', import.meta.url)
  const source = fs.readFileSync(URL.fileURLToPath(pluginURL), 'utf8')
  const pluginPath = path.join(directory, 'plugin.mjs')
  // Relocating the plugin must not change where its relative imports resolve.
  fs.writeFileSync(
    pluginPath,
    source.replace(
      /from (['"])(\.[^'"]+)\1/g,
      (_match: string, quote: string, specifier: string) =>
        `from ${quote}${new URL(specifier, pluginURL).href}${quote}`
    )
  )
  function packageFixture(name: string, content: string) {
    const packageDir = path.join(directory, 'node_modules', '@qvac', name)
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: { '.': './index.js', './addonLogging': './addonLogging.js' }
      })
    )
    fs.writeFileSync(path.join(packageDir, 'index.js'), content)
    fs.writeFileSync(
      path.join(packageDir, 'addonLogging.js'),
      "throw new Error('logging must stay lazy')"
    )
  }
  packageFixture(
    'embed-llamacpp',
    'export default class EmbedLlamacpp {}; export function assessFit() {}'
  )
  if (addon !== undefined) packageFixture('turbovec-ggml', addon)
  const { embeddingsPlugin } = await import(URL.pathToFileURL(pluginPath).href)
  return embeddingsPlugin.capabilities.turbovecIndexProvider as TurboVecIndexProvider
}

test('TurboVec loader imports without its optional dependency', async (t) => {
  const provider = await isolatedProvider(t)
  t.is(typeof provider.create, 'function')
  try {
    await provider.create({ dim: 8, storage: 'q8' })
    t.fail('loading a missing addon should reject')
  } catch (error) {
    t.ok(error instanceof Error)
    t.ok((error as Error).message.includes('install it to create or load an index'))
    t.ok((error as Error).cause instanceof Error, 'the resolution error is preserved')
  }
})

test('TurboVec loader defers module evaluation and preserves its failure', async (t) => {
  const provider = await isolatedProvider(t, "throw new Error('native binding unavailable')")
  t.pass('importing the loader did not evaluate the addon')
  try {
    await provider.create({ dim: 8, storage: 'q8' })
    t.fail('a broken addon should reject')
  } catch (error) {
    t.is(((error as Error).cause as Error).message, 'native binding unavailable')
  }
})

test('TurboVec loader resolves concurrent imports to the same constructor', async (t) => {
  const provider = await isolatedProvider(
    t,
    'export class IdMapIndex { static load() { return new IdMapIndex() } }'
  )
  const [first, second] = await Promise.all([
    provider.create({ dim: 8, storage: 'q8' }),
    provider.load('snapshot.qvi')
  ])
  t.is(typeof first, 'object')
  t.is(first.constructor, second.constructor)
  t.is((await provider.create({ dim: 8, storage: 'q8' })).constructor, first.constructor)
})
