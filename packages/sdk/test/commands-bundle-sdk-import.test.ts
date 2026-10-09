import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { bundleSdk } from '@/commands/bundle'
import { generateWorkerEntry } from '@/commands/bundle/entry-gen'
import { resolvePluginSpecifiers } from '@/commands/bundle/plugins'
import { listBundledAddons } from '@/commands/bundle/addons'
import { readBundle } from '@/commands/bundle/read-bundle'
import { getClientLogger } from '@/logging'
import { BundleFailedError, UnexpectedDeferredImportsError } from '@/utils/errors-client'
import { linkDependency } from './fixtures/link-dependency'

const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST = `${process.platform}-${process.arch}`

function writeFile(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function fakeBundleSdkProject(t: { after: (fn: () => void) => void }) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-bundle-')))
  const sdkPath = path.join(projectRoot, 'node_modules', '@qvac', 'sdk')
  const configPath = path.join(projectRoot, 'qvac.config.json')
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))

  writeFile(
    path.join(sdkPath, 'package.json'),
    JSON.stringify({
      name: '@qvac/sdk',
      type: 'module',
      exports: {
        './worker': './dist/worker.js',
        './llamacpp-completion/plugin': './dist/llm-plugin.js'
      }
    })
  )
  writeFile(path.join(sdkPath, 'bare-imports.json'), '{}\n')
  writeFile(
    path.join(sdkPath, 'dist', 'worker.js'),
    'export function startWorker(ipc, ready) { ready(); return async () => {} }\n'
  )
  writeFile(path.join(sdkPath, 'dist', 'llm-plugin.js'), 'export const llmPlugin = {}\n')
  writeFile(configPath, JSON.stringify({ plugins: ['@qvac/sdk/llamacpp-completion/plugin'] }))

  linkDependency(projectRoot, 'bare-stow', SDK_DIR)

  return { projectRoot, sdkPath, configPath, workerDir: path.join(projectRoot, 'qvac', 'worker') }
}

function addPlugin(sdkPath: string, suffix: string, file: string, source: string) {
  const manifestPath = path.join(sdkPath, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.exports[`./${suffix}/plugin`] = `./dist/${file}`
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFile(path.join(sdkPath, 'dist', file), source)
}

function addAddon(dir: string, name: string, extra: Record<string, unknown> = {}) {
  writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', main: 'index.js', addon: true, ...extra })
  )
  writeFile(path.join(dir, 'index.js'), 'module.exports = {}')
}

describe('generateWorkerEntry', () => {
  it('starts the worker with the selected built-in plugins', () => {
    const entry = generateWorkerEntry(['@qvac/sdk/llamacpp-completion/plugin'], '@qvac/sdk')
    assert.match(entry, /import \{ startWorker \} from "@qvac\/sdk\/worker"/)
    assert.match(entry, /import \{ llmPlugin \} from "@qvac\/sdk\/llamacpp-completion\/plugin"/)
    assert.match(entry, /export default function start\(ipc, ready\)/)
    assert.match(entry, /startWorker\(ipc, ready, \{ plugins: \[llmPlugin\] \}\)/)
  })

  it('imports custom plugins by their default export', () => {
    const entry = generateWorkerEntry(
      ['@qvac/sdk/llamacpp-completion/plugin', 'my-pkg/plugin'],
      '@qvac/sdk'
    )
    assert.match(entry, /import customPlugin1 from "my-pkg\/plugin"/)
    assert.match(entry, /plugins: \[llmPlugin, customPlugin1\]/)
  })

  it('leaves RPC native imports out of a model-only worker', () => {
    const entry = generateWorkerEntry(['@qvac/sdk/nmtcpp-translation/plugin'], '@qvac/sdk')
    assert.doesNotMatch(entry, /rpcServerProvider/)
  })

  it('passes an explicit provider to a server-only worker', () => {
    const plugins = resolvePluginSpecifiers(
      { plugins: [], rpcServerProvider: '@qvac/sdk/ggml-rpc-server/provider' },
      '@qvac/sdk',
      getClientLogger({ enableConsole: false })
    )
    assert.deepEqual(plugins, [])
    const entry = generateWorkerEntry(plugins, '@qvac/sdk', '@qvac/sdk/ggml-rpc-server/provider')
    assert.match(entry, /import rpcServerProvider from "@qvac\/sdk\/ggml-rpc-server\/provider"/)
    assert.match(entry, /\{ plugins: \[\], rpcServerProvider \}/)
  })

  it('quotes specifiers as module strings', () => {
    const entry = generateWorkerEntry([], '@qvac/sdk', 'custom"provider')
    assert.ok(entry.includes('from "custom\\"provider"'))
  })
})

describe('inference native dependency boundary', () => {
  it('packs a translation-only app without installing the RPC server addon', async (t) => {
    const require = createRequire(import.meta.url)
    const inferenceManifest = require.resolve('@qvac/inference/package')
    const inferenceRoot = path.dirname(inferenceManifest)
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-inference-optional-rpc-'))
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
    const isolatedRoot = path.join(projectRoot, 'node_modules', '@qvac', 'inference')
    fs.mkdirSync(isolatedRoot, { recursive: true })
    fs.copyFileSync(inferenceManifest, path.join(isolatedRoot, 'package.json'))
    fs.cpSync(path.join(inferenceRoot, 'dist'), path.join(isolatedRoot, 'dist'), {
      recursive: true
    })
    const manifest = JSON.parse(fs.readFileSync(inferenceManifest, 'utf8'))
    // Include the selected model addon, its language detector, and runtime dependencies.
    for (const dependency of [
      ...Object.keys(manifest.dependencies),
      '@qvac/translation-nmtcpp',
      '@qvac/langdetect-text'
    ]) {
      linkDependency(projectRoot, dependency, inferenceRoot)
    }
    const isolatedRequire = createRequire(path.join(isolatedRoot, 'package.json'))
    assert.throws(() => isolatedRequire.resolve('@qvac/ggml-rpc-server'))
    const entryPath = path.join(projectRoot, 'entry.mjs')
    fs.writeFileSync(
      entryPath,
      [
        "import { registerPlugin, heartbeat } from '@qvac/inference';",
        "import { nmtPlugin } from '@qvac/inference/nmtcpp-translation/plugin';",
        'registerPlugin(nmtPlugin);',
        'await heartbeat();'
      ].join('\n')
    )
    const bundlePath = path.join(projectRoot, 'worker.bundle.js')
    const packBin = path.join(path.dirname(require.resolve('bare-pack/package')), 'bin.js')
    execFileSync(packBin, ['--host', HOST, '--linked', '--out', bundlePath, entryPath], {
      stdio: 'pipe'
    })
    const bundle = await readBundle(bundlePath)
    assert.doesNotMatch(JSON.stringify(bundle.resolutions), /ggml-rpc-server|rpc\/ggml-provider/)
    const addons = await listBundledAddons({
      bundlePath,
      projectRoot,
      logger: getClientLogger({ enableConsole: false })
    })
    assert.ok(addons.some((addon) => addon.includes('translation-nmtcpp')))
    assert.ok(addons.every((addon) => !addon.includes('ggml-rpc-server')))
  })
})

async function assertDecoderExcludedFromBundle(
  result: Awaited<ReturnType<typeof bundleSdk>>
): Promise<void> {
  assert.ok(!result.addons.includes('bare-ffmpeg'))
  const { resolutions } = await readBundle(result.bundlePath)
  assert.ok(
    !Object.keys(resolutions).some((key) => key.includes('/node_modules/bare-ffmpeg/')),
    'bare-ffmpeg module must not be in the bundle graph'
  )
  assert.ok(JSON.stringify(resolutions).includes('deferred:bare-ffmpeg'))
}

describe('bundleSdk', () => {
  it('writes the entry, the harness and the bundle for this host', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)

    const result = await bundleSdk({ projectRoot, configPath, quiet: true })

    assert.equal(result.target, 'bare-sidecar')
    assert.deepEqual(result.hosts, [HOST])
    assert.equal(result.entryPath, path.join(projectRoot, 'qvac', 'worker.entry.mjs'))
    assert.equal(result.harnessPath, path.join(workerDir, 'index.mjs'))
    assert.equal(result.bundlePath, path.join(workerDir, 'index.bundle'))
    assert.match(fs.readFileSync(result.entryPath, 'utf8'), /from "@qvac\/sdk\/worker"/)
    assert.match(fs.readFileSync(result.harnessPath, 'utf8'), /bare-sidecar/)
    assert.equal((await readBundle(result.bundlePath)).main, '/qvac/__main__.mjs')
  })

  it('replaces the output of an earlier run', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)
    writeFile(path.join(workerDir, 'stale.bare'), '')

    await bundleSdk({ projectRoot, configPath, quiet: true })

    assert.ok(!fs.existsSync(path.join(workerDir, 'stale.bare')))
  })

  it('bundles a PCM-only audio plugin without linking bare-ffmpeg', async (t) => {
    const { projectRoot, sdkPath, configPath } = fakeBundleSdkProject(t)
    addAddon(path.join(sdkPath, 'node_modules', 'bare-ffmpeg'), 'bare-ffmpeg')
    addPlugin(
      sdkPath,
      'whispercpp-transcription',
      'whisper-plugin.js',
      "export const whisperPlugin = { decode: () => require('bare-ffmpeg') };"
    )
    writeFile(
      configPath,
      JSON.stringify({
        plugins: ['@qvac/sdk/whispercpp-transcription/plugin'],
        includeAudioDecoder: false
      })
    )

    const result = await bundleSdk({ projectRoot, configPath, quiet: true })
    await assertDecoderExcludedFromBundle(result)

    writeFile(
      configPath,
      JSON.stringify({ plugins: ['@qvac/sdk/whispercpp-transcription/plugin'] })
    )
    const warnings: string[] = []
    const originalInfo = console.info
    const originalWarn = console.warn
    t.after(() => {
      console.info = originalInfo
      console.warn = originalWarn
    })
    console.info = () => {}
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    const explicitlyDeferred = await bundleSdk({
      projectRoot,
      configPath,
      defer: ['bare-ffmpeg']
    })
    await assertDecoderExcludedFromBundle(explicitlyDeferred)
    assert.ok(warnings.some((message) => message.includes('cannot decode compressed audio files')))
  })

  it('omits bare-ffmpeg from the addon manifest when audio decoding is disabled', async (t) => {
    const { projectRoot, sdkPath, configPath } = fakeBundleSdkProject(t)
    addAddon(path.join(sdkPath, 'node_modules', 'bare-ffmpeg'), 'bare-ffmpeg')
    addPlugin(
      sdkPath,
      'audiogen-ggml',
      'audiogen-plugin.js',
      "export const audioGenPlugin = { encode: () => require('bare-ffmpeg') }"
    )
    writeFile(
      configPath,
      JSON.stringify({ plugins: ['@qvac/sdk/audiogen-ggml/plugin'], includeAudioDecoder: false })
    )

    const result = await bundleSdk({ projectRoot, configPath, quiet: true })

    await assertDecoderExcludedFromBundle(result)
  })

  it("allows a split addon's own require.addon() to stay unresolved", async (t) => {
    const { projectRoot, sdkPath, configPath } = fakeBundleSdkProject(t)
    const addonDir = path.join(sdkPath, 'node_modules', 'split-addon')
    addAddon(addonDir, 'split-addon', {
      imports: { '#host-addon': { default: './addon-unavailable.js' } }
    })
    writeFile(
      path.join(addonDir, 'index.js'),
      "try { module.exports = require.addon() } catch { module.exports = require('#host-addon') }"
    )
    writeFile(path.join(addonDir, 'addon-unavailable.js'), 'module.exports = null')
    addPlugin(
      sdkPath,
      'llamacpp-completion',
      'llm-plugin.js',
      "import addon from 'split-addon'\nexport const llmPlugin = { addon }\n"
    )

    const result = await bundleSdk({ projectRoot, configPath, quiet: true })

    assert.match(JSON.stringify((await readBundle(result.bundlePath)).resolutions), /deferred:\./)
  })

  it('rejects a bundle that leaves an import unresolved', async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)
    writeFile(configPath, JSON.stringify({ plugins: ['missing-package/plugin'] }))

    await assert.rejects(
      bundleSdk({ projectRoot, configPath, quiet: true }),
      (error: unknown) =>
        error instanceof UnexpectedDeferredImportsError &&
        error.message.includes('missing-package/plugin')
    )
  })

  it('reports a module the phone bundle cannot resolve', async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)
    linkDependency(projectRoot, 'bare-stow-target-react-native', SDK_DIR)
    writeFile(configPath, JSON.stringify({ plugins: ['missing-package/plugin'] }))

    await assert.rejects(
      bundleSdk({
        projectRoot,
        configPath,
        target: 'react-native',
        quiet: true,
        checkEngines: false
      }),
      (error: unknown) => error instanceof BundleFailedError
    )
  })
})
