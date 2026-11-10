import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { bundleSdk, describeMissingAddonBuild } from '@/commands/bundle'
import { SCRATCH_OWNER_FILE, scratchFolderFor } from '@/commands/bundle/scratch'
import {
  BARE_PACK_NODE_ENGINES,
  assertNodeCanBundle,
  isBarePackNodeSupported
} from '@/commands/bundle/node-support'
import { SDK_CLIENT_ERROR_CODES } from '@/schemas/sdk-errors-client'
import { generateWorkerEntry } from '@/commands/bundle/entry-gen'
import { resolvePluginSpecifiers } from '@/commands/bundle/plugins'
import { listBundledAddons } from '@/commands/bundle/addons'
import { bundleRoot, readBundle } from '@/commands/bundle/read-bundle'
import { getClientLogger } from '@/logging'
import {
  BarePackNodeUnsupportedError,
  BundleFailedError,
  BundleTargetNotInstalledError,
  BundleVerificationFailedError,
  HostPrebuildsMissingError
} from '@/utils/errors-client'
import { loadTargetPackage } from '@/commands/bundle/targets'
import { parseBareKitPins } from '@/commands/verify/bare-kit-runtime'
import { bundleTargetOf } from '@/client/rpc/bundle-stamp'
import { linkDependency } from './fixtures/link-dependency'

const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST = `${process.platform}-${process.arch}`

function writeFile(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

function writeFakeSdk(sdkPath: string) {
  writeFile(
    path.join(sdkPath, 'package.json'),
    JSON.stringify({
      name: '@qvac/sdk',
      version: '1.2.3',
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
}

function fakeBundleSdkProject(t: { after: (fn: () => void) => void }) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-bundle-')))
  const sdkPath = path.join(projectRoot, 'node_modules', '@qvac', 'sdk')
  const configPath = path.join(projectRoot, 'qvac.config.json')
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))

  writeFakeSdk(sdkPath)
  writeFile(configPath, JSON.stringify({ plugins: ['@qvac/sdk/llamacpp-completion/plugin'] }))

  linkDependency(projectRoot, 'bare-stow-runtime', SDK_DIR)
  linkDependency(projectRoot, 'bare-stow-host', SDK_DIR)
  linkDependency(projectRoot, 'bare-sidecar', SDK_DIR)

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

  it('imports through the given resolver', () => {
    const entry = generateWorkerEntry(
      ['@qvac/sdk/llamacpp-completion/plugin', 'my-pkg/plugin'],
      '@qvac/sdk',
      undefined,
      (specifier) => specifier.replace('@qvac/sdk/', 'file:///sdk/')
    )
    assert.match(entry, /import \{ startWorker \} from "file:\/\/\/sdk\/worker"/)
    assert.match(entry, /import \{ llmPlugin \} from "file:\/\/\/sdk\/llamacpp-completion\/plugin"/)
    assert.match(entry, /import customPlugin1 from "my-pkg\/plugin"/)
  })
})

describe('loadTargetPackage', () => {
  it('names a target package neither the project nor the SDK has', async (t) => {
    const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-target-')))
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))

    await assert.rejects(
      loadTargetPackage('pear-runtime', 'qvac-missing-stow-target', projectRoot),
      (error: unknown) =>
        error instanceof BundleTargetNotInstalledError &&
        error.message.includes('qvac-missing-stow-target')
    )
  })

  it('loads the target package the project installed', async (t) => {
    const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-target-')))
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
    const targetDir = path.join(projectRoot, 'node_modules', 'qvac-project-stow-target')
    writeFile(
      path.join(targetDir, 'package.json'),
      JSON.stringify({ name: 'qvac-project-stow-target', main: 'index.js' })
    )
    writeFile(path.join(targetDir, 'index.js'), "exports.name = 'project-target'\n")

    const target = await loadTargetPackage('pear-runtime', 'qvac-project-stow-target', projectRoot)

    assert.equal((target as { name?: string }).name, 'project-target')
  })
})

describe('describeMissingAddonBuild', () => {
  it('names the scoped addon and only the hosts the bundler reports missing', () => {
    const error = Object.assign(
      new Error(
        "Cannot find addon '.' imported from 'x' for hosts 'win32-arm64', 'linux-arm64'\nCandidates:"
      ),
      {
        code: 'ADDON_NOT_FOUND',
        referrer: { href: 'file:///app/node_modules/@qvac/sdk/node_modules/@qvac/ocr/index.js' }
      }
    )

    assert.match(
      describeMissingAddonBuild(error, ['darwin-arm64', 'win32-arm64', 'linux-arm64'])!.message,
      /^@qvac\/ocr has no native build for win32-arm64, linux-arm64\./
    )
  })

  it('leaves any other error alone', () => {
    assert.equal(describeMissingAddonBuild(new Error('boom'), ['linux-x64']), null)
  })
})

describe('bundleRoot', () => {
  it('is the project root for a bundle based there', () => {
    assert.equal(bundleRoot('/qvac/__main__.cjs', '/work/app'), '/work/app')
  })

  it('climbs to the base above the project that the bundle names', () => {
    assert.equal(bundleRoot('/packages/app/qvac/__main__.cjs', '/work/packages/app'), '/work')
  })

  it('falls back to the project root for a bundle with another main', () => {
    assert.equal(bundleRoot('/entry.mjs', '/work/app'), '/work/app')
    assert.equal(bundleRoot(null, '/work/app'), '/work/app')
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
    const bundlePath = path.join(projectRoot, 'index.bundle')
    const base = path.parse(fs.realpathSync(projectRoot)).root
    // The SDK reaches bare-pack only through bare-stow, which declares it.
    const bareStowRequire = createRequire(require.resolve('bare-stow/package'))
    const packBin = path.join(path.dirname(bareStowRequire.resolve('bare-pack/package')), 'bin.js')
    execFileSync(
      packBin,
      ['--host', HOST, '--linked', '--base', base, '--out', bundlePath, entryPath],
      { stdio: 'pipe' }
    )
    const bundle = await readBundle(bundlePath)
    assert.doesNotMatch(JSON.stringify(bundle.resolutions), /ggml-rpc-server|rpc\/ggml-provider/)
    const addons = await listBundledAddons({
      bundlePath,
      projectRoot: base,
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
  assert.ok(!result.addonModules.some((file) => file.includes(`${path.sep}bare-ffmpeg${path.sep}`)))
  const { resolutions } = await readBundle(result.bundlePath)
  assert.ok(
    !Object.keys(resolutions).some((key) => key.includes('/node_modules/bare-ffmpeg/')),
    'bare-ffmpeg module must not be in the bundle graph'
  )
  assert.ok(JSON.stringify(resolutions).includes('deferred:bare-ffmpeg'))
}

describe('isBarePackNodeSupported', () => {
  it('accepts Node 22.21+ and 24.9+, rejects everything older and Node 23', () => {
    for (const version of ['22.21.0', '22.30.1', '24.9.0', '24.20.0', '24.10.0-rc.1', '26.0.0']) {
      assert.equal(isBarePackNodeSupported(version), true, version)
    }
    for (const version of ['20.11.0', '22.20.0', '23.11.0', '24.8.0', 'nightly']) {
      assert.equal(isBarePackNodeSupported(version), false, version)
    }
  })

  it('matches the engines.node of @qvac/cli, which qvac doctor reports', () => {
    const cliManifest = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'cli', 'package.json'), 'utf8')
    ) as { engines: { node: string } }
    assert.equal(cliManifest.engines.node, BARE_PACK_NODE_ENGINES)
  })
})

describe('assertNodeCanBundle', () => {
  it('throws BARE_PACK_NODE_UNSUPPORTED on an unsupported Node', () => {
    assert.throws(
      () => assertNodeCanBundle({ node: '22.20.0' }),
      (error: unknown) =>
        error instanceof BarePackNodeUnsupportedError &&
        error.code === SDK_CLIENT_ERROR_CODES.BARE_PACK_NODE_UNSUPPORTED &&
        /\^22\.21\.0 \|\| >=24\.9\.0/.test(error.message) &&
        /v22\.20\.0/.test(error.message)
    )
  })

  it('does not check Bun, which reports an emulated Node version', () => {
    assert.doesNotThrow(() => assertNodeCanBundle({ node: '22.20.0', bun: '1.4.2' }))
  })
})

describe('bundleSdk', () => {
  it('writes the entry, the harness and the bundle for this host', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)

    const result = await bundleSdk({ projectRoot, configPath, quiet: true })

    assert.equal(result.target, 'bare-sidecar')
    assert.deepEqual(result.hosts, [HOST])
    assert.equal(result.entryPath, path.join(projectRoot, 'qvac', 'worker.entry.mjs'))
    assert.equal(result.outputDir, workerDir)
    assert.equal(result.bundlePath, path.join(workerDir, 'index.bundle'))
    assert.match(fs.readFileSync(result.entryPath, 'utf8'), /from "@qvac\/sdk\/worker"/)
    assert.match(fs.readFileSync(path.join(result.outputDir, 'index.js'), 'utf8'), /bare-sidecar/)
    const { main } = await readBundle(result.bundlePath)
    assert.equal(bundleRoot(main, projectRoot), path.parse(projectRoot).root)
  })

  it("writes bare-stow's Kotlin module for bare-kit to the given folder", async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)
    const outputDir = path.join(projectRoot, 'android', 'worker')

    const result = await bundleSdk({
      projectRoot,
      configPath,
      target: 'bare-kit',
      language: 'kotlin',
      languageOptions: { package: 'com.example.worker' },
      outputDir,
      quiet: true
    })

    assert.equal(result.language, 'kotlin')
    assert.deepEqual(result.hosts, ['android-arm64'])
    assert.equal(result.outputDir, outputDir)
    assert.equal(
      result.bundlePath,
      path.join(outputDir, 'src', 'main', 'assets', 'com', 'example', 'worker', 'index.bundle')
    )
    const harness = path.join(outputDir, 'src', 'main', 'kotlin', 'com', 'example', 'worker')
    assert.match(fs.readFileSync(path.join(harness, 'Harness.kt'), 'utf8'), /suspend fun start/)
    assert.match(fs.readFileSync(path.join(outputDir, 'build.gradle'), 'utf8'), /bare-kit-kotlin/)
    assert.equal(bundleTargetOf(result.bundlePath), 'bare-kit')
  })

  it('bundles for pear-runtime with the target package the SDK installs', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)

    const result = await bundleSdk({ projectRoot, configPath, target: 'pear-runtime', quiet: true })

    assert.equal(result.target, 'pear-runtime')
    assert.equal(result.bundlePath, path.join(workerDir, 'index.bundle'))
    assert.match(fs.readFileSync(path.join(workerDir, 'index.js'), 'utf8'), /pear\.run\(bundle,/)
    assert.match(fs.readFileSync(result.bundlePath, 'latin1'), /bare-stow-runtime\/process/)
  })

  it('bundles an SDK from outside the project, with its own bare-stow runtime', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-bundle-outside-')))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const sdkPath = path.join(root, 'sdk')
    const projectRoot = path.join(root, 'app')
    const configPath = path.join(projectRoot, 'qvac.config.json')
    writeFakeSdk(sdkPath)
    linkDependency(sdkPath, 'bare-stow-runtime', SDK_DIR)
    linkDependency(projectRoot, 'bare-stow-runtime', SDK_DIR)
    linkDependency(projectRoot, 'bare-stow-host', SDK_DIR)
    linkDependency(projectRoot, 'bare-sidecar', SDK_DIR)
    writeFile(configPath, JSON.stringify({ plugins: ['@qvac/sdk/llamacpp-completion/plugin'] }))

    const result = await bundleSdk({ projectRoot, configPath, sdkPath, quiet: true })

    const entry = fs.readFileSync(result.entryPath, 'utf8')
    assert.ok(
      entry.includes(JSON.stringify(pathToFileURL(path.join(sdkPath, 'dist', 'worker.js')).href))
    )
    const { main, resolutions } = await readBundle(result.bundlePath)
    assert.ok(main?.endsWith('/app/qvac/__main__.cjs'))
    assert.ok(Object.keys(resolutions).some((key) => key.endsWith('/sdk/dist/worker.js')))
  })

  it("copies an outside SDK's addon resources beside the offloaded binary", async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-bundle-outside-')))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const sdkPath = path.join(root, 'sdk')
    const projectRoot = path.join(root, 'app')
    const configPath = path.join(projectRoot, 'qvac.config.json')
    writeFakeSdk(sdkPath)
    linkDependency(sdkPath, 'bare-stow-runtime', SDK_DIR)
    linkDependency(projectRoot, 'bare-stow-runtime', SDK_DIR)
    linkDependency(projectRoot, 'bare-stow-host', SDK_DIR)
    linkDependency(projectRoot, 'bare-sidecar', SDK_DIR)
    const addonDir = path.join(sdkPath, 'node_modules', 'resource-addon')
    addAddon(addonDir, 'resource-addon')
    writeFile(path.join(addonDir, 'index.js'), 'module.exports = require.addon()')
    writeFile(path.join(addonDir, 'prebuilds', HOST, 'resource-addon.bare'), 'binary')
    writeFile(path.join(addonDir, 'prebuilds', HOST, 'resource-addon', 'backend.so'), 'backend')
    addPlugin(
      sdkPath,
      'llamacpp-completion',
      'llm-plugin.js',
      "import addon from 'resource-addon'\nexport const llmPlugin = { addon }\n"
    )
    writeFile(configPath, JSON.stringify({ plugins: ['@qvac/sdk/llamacpp-completion/plugin'] }))

    const result = await bundleSdk({ projectRoot, configPath, sdkPath, quiet: true })

    const offloaded = fs
      .readdirSync(path.dirname(result.bundlePath), { recursive: true, encoding: 'utf8' })
      .find((file) => file.endsWith(`${path.sep}resource-addon.bare`))
    assert.ok(offloaded, 'the addon binary is offloaded beside the bundle')
    const backend = path.join(
      path.dirname(result.bundlePath),
      offloaded.slice(0, -'.bare'.length),
      'backend.so'
    )
    assert.equal(fs.readFileSync(backend, 'utf8'), 'backend')
  })

  it('replaces the output of an earlier run', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)
    writeFile(path.join(workerDir, 'stale.bare'), '')

    await bundleSdk({ projectRoot, configPath, quiet: true })

    assert.ok(!fs.existsSync(path.join(workerDir, 'stale.bare')))
  })

  it('records the SDK version in the bundled worker', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)

    await bundleSdk({ projectRoot, configPath, quiet: true })

    const manifest = JSON.parse(fs.readFileSync(path.join(workerDir, 'package.json'), 'utf8'))
    assert.equal(manifest.qvacSdkVersion, '1.2.3')
  })

  it('refuses a given output folder that has files, and keeps them', async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)
    const outputDir = path.join(projectRoot, 'src')
    writeFile(path.join(outputDir, 'app.js'), '')

    await assert.rejects(
      bundleSdk({ projectRoot, configPath, outputDir, quiet: true }),
      (error: unknown) =>
        error instanceof BundleFailedError && error.message.includes('must be empty or not exist')
    )
    assert.ok(fs.existsSync(path.join(outputDir, 'app.js')))
  })

  it('bundles into a given empty output folder', async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)
    const outputDir = path.join(projectRoot, 'out')
    fs.mkdirSync(outputDir)

    const result = await bundleSdk({ projectRoot, configPath, outputDir, quiet: true })

    assert.ok(fs.existsSync(path.join(outputDir, 'index.js')))
    assert.equal(result.bundlePath, path.join(outputDir, 'index.bundle'))
  })

  it('bundles into an empty output folder named previous', async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)
    const outputDir = path.join(projectRoot, 'out', 'previous')
    fs.mkdirSync(outputDir, { recursive: true })

    const result = await bundleSdk({ projectRoot, configPath, outputDir, quiet: true })

    assert.ok(fs.existsSync(path.join(outputDir, 'index.js')))
    assert.equal(result.bundlePath, path.join(outputDir, 'index.bundle'))
  })

  it('resolves a relative output folder against the project root', async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-bundle-cwd-')))
    const originalCwd = process.cwd()
    process.chdir(cwd)
    t.after(() => {
      process.chdir(originalCwd)
      fs.rmSync(cwd, { recursive: true, force: true })
    })

    const result = await bundleSdk({ projectRoot, configPath, outputDir: 'out', quiet: true })

    assert.equal(result.outputDir, path.join(projectRoot, 'out'))
    assert.ok(fs.existsSync(path.join(projectRoot, 'out', 'index.js')))
    assert.deepEqual(fs.readdirSync(cwd), [])
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

  it('leaves bare-ffmpeg out of the bundle when audio decoding is disabled', async (t) => {
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

  it('rejects a bundle that leaves an import unresolved', async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)
    writeFile(configPath, JSON.stringify({ plugins: ['missing-package/plugin'] }))

    await assert.rejects(
      bundleSdk({ projectRoot, configPath, quiet: true }),
      (error: unknown) =>
        error instanceof BundleFailedError && error.message.includes('missing-package/plugin')
    )
  })

  it('imports an SDK installed under a symlinked project path by name', async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)
    const linkedRoot = `${projectRoot}-link`
    fs.symlinkSync(projectRoot, linkedRoot, 'dir')
    t.after(() => fs.rmSync(linkedRoot, { force: true }))

    const result = await bundleSdk({ projectRoot: linkedRoot, configPath, quiet: true })

    assert.match(fs.readFileSync(result.entryPath, 'utf8'), /from "@qvac\/sdk\/worker"/)
  })

  it('bundles a custom plugin that imports the SDK by name under a linked SDK', async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-bundle-linked-')))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const sdkPath = path.join(root, 'sdk')
    const projectRoot = path.join(root, 'app')
    const configPath = path.join(projectRoot, 'qvac.config.json')
    writeFakeSdk(sdkPath)
    addPlugin(sdkPath, 'plugin-utils', 'plugin-utils.js', "export * from 'fake-inference'\n")
    const manifestPath = path.join(sdkPath, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.exports['./plugin-utils'] = './dist/plugin-utils.js'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFile(
      path.join(sdkPath, 'node_modules', 'fake-inference', 'package.json'),
      JSON.stringify({ name: 'fake-inference', main: 'index.js' })
    )
    writeFile(
      path.join(sdkPath, 'node_modules', 'fake-inference', 'index.js'),
      'exports.definePlugin = (plugin) => plugin\n'
    )
    linkDependency(sdkPath, 'bare-stow-runtime', SDK_DIR)
    fs.mkdirSync(path.join(projectRoot, 'node_modules', '@qvac'), { recursive: true })
    fs.symlinkSync(sdkPath, path.join(projectRoot, 'node_modules', '@qvac', 'sdk'), 'dir')
    linkDependency(projectRoot, 'bare-stow-runtime', SDK_DIR)
    linkDependency(projectRoot, 'bare-stow-host', SDK_DIR)
    linkDependency(projectRoot, 'bare-sidecar', SDK_DIR)
    writeFile(
      path.join(projectRoot, 'node_modules', 'my-plugin', 'package.json'),
      JSON.stringify({ name: 'my-plugin', exports: { './plugin': './plugin.js' } })
    )
    writeFile(
      path.join(projectRoot, 'node_modules', 'my-plugin', 'plugin.js'),
      "const { definePlugin } = require('@qvac/sdk/plugin-utils')\nmodule.exports = definePlugin({})\n"
    )
    writeFile(configPath, JSON.stringify({ plugins: ['my-plugin/plugin'] }))

    const result = await bundleSdk({ projectRoot, configPath, quiet: true })

    const { resolutions } = await readBundle(result.bundlePath)
    assert.ok(Object.keys(resolutions).some((key) => key.endsWith('/fake-inference/index.js')))
  })

  it('names the missing platform package of a desktop host', async (t) => {
    const { projectRoot, sdkPath, configPath } = fakeBundleSdkProject(t)
    const addonDir = path.join(sdkPath, 'node_modules', 'split-addon')
    writeFile(
      path.join(addonDir, 'package.json'),
      JSON.stringify({
        name: 'split-addon',
        version: '1.0.0',
        main: 'index.js',
        imports: {
          '#host-addon': {
            [process.platform]: { [process.arch]: `split-addon-${HOST}` },
            default: './addon-unavailable.js'
          }
        }
      })
    )
    writeFile(path.join(addonDir, 'index.js'), "module.exports = require('#host-addon')\n")
    writeFile(path.join(addonDir, 'addon-unavailable.js'), 'module.exports = null\n')
    addPlugin(
      sdkPath,
      'llamacpp-completion',
      'llm-plugin.js',
      "import addon from 'split-addon'\nexport const llmPlugin = { addon }\n"
    )

    await assert.rejects(
      bundleSdk({ projectRoot, configPath, quiet: true }),
      (error: unknown) =>
        error instanceof HostPrebuildsMissingError &&
        error.dependencies[`split-addon-${HOST}`] === '1.0.0'
    )
  })

  it('fails verification for an addon with no prebuild for a bundled host', async (t) => {
    const { projectRoot, sdkPath, configPath } = fakeBundleSdkProject(t)
    linkDependency(projectRoot, 'react-native-bare-kit', SDK_DIR)
    addAddon(path.join(sdkPath, 'node_modules', 'phone-addon'), 'phone-addon')
    writeFile(
      path.join(sdkPath, 'node_modules', 'phone-addon', 'index.js'),
      'module.exports = require.addon()'
    )
    addPlugin(
      sdkPath,
      'llamacpp-completion',
      'llm-plugin.js',
      "import addon from 'phone-addon'\nexport const llmPlugin = { addon }\n"
    )

    await assert.rejects(
      bundleSdk({
        projectRoot,
        configPath,
        target: 'react-native',
        hosts: ['android-arm64'],
        link: false,
        quiet: true
      }),
      (error: unknown) =>
        error instanceof BundleVerificationFailedError &&
        error.cause instanceof Error &&
        error.cause.message.includes('phone-addon@1.0.0 for android-arm64')
    )
  })

  it('checks a phone bundle against the Bare Kit of the bare-stow that bundled it', async (t) => {
    const { projectRoot, sdkPath, configPath } = fakeBundleSdkProject(t)
    linkDependency(projectRoot, 'react-native-bare-kit', SDK_DIR)
    linkDependency(projectRoot, 'bare-stow-target-react-native', SDK_DIR)
    // The project's SDK has its own bare-stow, pinning a Bare Kit with no known Bare.
    const projectBareStow = path.join(sdkPath, 'node_modules', 'bare-stow')
    writeFile(
      path.join(projectBareStow, 'package.json'),
      JSON.stringify({ name: 'bare-stow', version: '0.0.1' })
    )
    writeFile(
      path.join(projectBareStow, 'lib', 'target', 'bare-kit.js'),
      "const bareKitKotlin = { 'com.github.holepunchto.bare-kit-kotlin:bare-kit-kotlin': 'v0.0.1' }\n"
    )
    const bundlerBareStow = path.dirname(
      createRequire(import.meta.url).resolve('bare-stow/package')
    )
    const bundlerPins = parseBareKitPins(
      fs.readFileSync(path.join(bundlerBareStow, 'lib', 'target', 'bare-kit.js'), 'utf8')
    )

    const result = await bundleSdk({
      projectRoot,
      configPath,
      target: 'react-native',
      hosts: ['android-arm64'],
      link: false,
      network: false,
      quiet: true
    })

    const resolution = result.verification?.runtimes.find((runtime) =>
      runtime.hosts.includes('android-arm64')
    )?.resolution
    assert.ok(resolution?.resolved === true)
    assert.equal(resolution.runtime.packageVersion, bundlerPins.android)
  })

  it('names the addon and hosts a desktop bundle has no native build for', async (t) => {
    const { projectRoot, sdkPath, configPath } = fakeBundleSdkProject(t)
    addAddon(path.join(sdkPath, 'node_modules', 'desktop-addon'), 'desktop-addon')
    writeFile(
      path.join(sdkPath, 'node_modules', 'desktop-addon', 'index.js'),
      'module.exports = require.addon()'
    )
    addPlugin(
      sdkPath,
      'llamacpp-completion',
      'llm-plugin.js',
      "import addon from 'desktop-addon'\nexport const llmPlugin = { addon }\n"
    )

    await assert.rejects(
      bundleSdk({ projectRoot, configPath, quiet: true }),
      (error: unknown) =>
        error instanceof BundleFailedError &&
        error.message.includes(`desktop-addon has no native build for ${HOST}`) &&
        !error.message.includes('Candidates')
    )
  })

  it('fails a phone bundle without react-native-bare-kit', async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)

    await assert.rejects(
      bundleSdk({ projectRoot, configPath, target: 'react-native', quiet: true }),
      (error: unknown) =>
        error instanceof BundleFailedError &&
        error.message.includes("imports 'react-native-bare-kit'")
    )
  })

  it('fails when the harness cannot resolve a package it imports', async (t) => {
    const { projectRoot, configPath } = fakeBundleSdkProject(t)
    fs.rmSync(path.join(projectRoot, 'node_modules', 'bare-sidecar'))

    await assert.rejects(
      bundleSdk({ projectRoot, configPath, quiet: true }),
      (error: unknown) =>
        error instanceof BundleFailedError && error.message.includes("imports 'bare-sidecar'")
    )
  })

  it('keeps the last good bundle when a later bundle fails', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)
    await bundleSdk({ projectRoot, configPath, quiet: true })
    const harness = fs.readFileSync(path.join(workerDir, 'index.js'), 'utf8')
    fs.rmSync(path.join(projectRoot, 'node_modules', 'bare-sidecar'))

    await assert.rejects(
      bundleSdk({ projectRoot, configPath, quiet: true }),
      (error: unknown) => error instanceof BundleFailedError
    )

    assert.equal(fs.readFileSync(path.join(workerDir, 'index.js'), 'utf8'), harness)
    assert.ok(fs.existsSync(path.join(workerDir, 'index.bundle')))
    assert.deepEqual(
      fs.readdirSync(path.dirname(workerDir)).filter((name) => name.startsWith('.')),
      []
    )
  })

  it('keeps the last good bundle when the new one fails verification', async (t) => {
    const { projectRoot, sdkPath, configPath, workerDir } = fakeBundleSdkProject(t)
    linkDependency(projectRoot, 'react-native-bare-kit', SDK_DIR)
    linkDependency(projectRoot, 'bare-stow-target-react-native', SDK_DIR)
    const options = {
      projectRoot,
      configPath,
      target: 'react-native' as const,
      hosts: ['android-arm64'],
      link: false,
      quiet: true
    }
    const result = await bundleSdk(options)
    const files = fs.readdirSync(workerDir)
    const contents = files.map((file) => fs.readFileSync(path.join(workerDir, file)))
    const entry = fs.readFileSync(result.entryPath, 'utf8')
    writeFile(
      path.join(projectRoot, 'node_modules', 'extra-plugin', 'package.json'),
      JSON.stringify({ name: 'extra-plugin', exports: { './plugin': './plugin.js' } })
    )
    writeFile(
      path.join(projectRoot, 'node_modules', 'extra-plugin', 'plugin.js'),
      'module.exports = {}\n'
    )
    writeFile(
      configPath,
      JSON.stringify({ plugins: ['@qvac/sdk/llamacpp-completion/plugin', 'extra-plugin/plugin'] })
    )
    addAddon(path.join(sdkPath, 'node_modules', 'phone-addon'), 'phone-addon')
    writeFile(
      path.join(sdkPath, 'node_modules', 'phone-addon', 'index.js'),
      'module.exports = require.addon()'
    )
    addPlugin(
      sdkPath,
      'llamacpp-completion',
      'llm-plugin.js',
      "import addon from 'phone-addon'\nexport const llmPlugin = { addon }\n"
    )

    await assert.rejects(
      bundleSdk(options),
      (error: unknown) => error instanceof BundleVerificationFailedError
    )

    assert.deepEqual(fs.readdirSync(workerDir), files)
    files.forEach((file, index) => {
      assert.ok(fs.readFileSync(path.join(workerDir, file)).equals(contents[index]!))
    })
    assert.equal(fs.readFileSync(result.entryPath, 'utf8'), entry)
    assert.deepEqual(
      fs.readdirSync(path.dirname(workerDir)).filter((name) => name.startsWith('.')),
      []
    )
  })

  it('keeps the last good bundle when the native module cannot be written', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)
    linkDependency(projectRoot, 'react-native-bare-kit', SDK_DIR)
    linkDependency(projectRoot, 'bare-stow-target-react-native', SDK_DIR)
    const options = {
      projectRoot,
      configPath,
      target: 'react-native' as const,
      hosts: ['android-arm64'],
      verify: false,
      quiet: true
    }
    await bundleSdk({ ...options, link: false })
    writeFile(path.join(workerDir, 'first-bundle'), '')
    writeFile(path.join(projectRoot, 'android'), 'a file where the Android project belongs')

    await assert.rejects(bundleSdk(options), (error: unknown) =>
      String((error as Error).message).includes('qvac-bare-kit')
    )

    assert.ok(fs.existsSync(path.join(workerDir, 'first-bundle')))
  })

  it('keeps the last good bundle in its scratch folder when it cannot be moved back', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)
    await bundleSdk({ projectRoot, configPath, quiet: true })
    const harness = fs.readFileSync(path.join(workerDir, 'index.js'), 'utf8')
    const rename = fs.promises.rename
    t.mock.method(fs.promises, 'rename', async (from: string, to: string) => {
      if (to === workerDir) throw new Error('EACCES: permission denied')
      return rename(from, to)
    })

    const error = await bundleSdk({ projectRoot, configPath, quiet: true }).then(
      () => assert.fail('the bundle replaced the output folder'),
      (error: unknown) => error as Error
    )

    const qvacDir = path.dirname(workerDir)
    const scratch = fs.readdirSync(qvacDir).filter((name) => name.startsWith('.worker-'))
    assert.equal(scratch.length, 1)
    const backups = fs
      .readdirSync(path.join(qvacDir, scratch[0]!))
      .filter((name) => name !== path.basename(workerDir) && name !== SCRATCH_OWNER_FILE)
    assert.equal(backups.length, 1)
    const backup = path.join(qvacDir, scratch[0]!, backups[0]!)
    assert.equal(fs.readFileSync(path.join(backup, 'index.js'), 'utf8'), harness)
    assert.ok(error.message.includes(backup), error.message)
  })

  it('removes scratch folders an interrupted bundle left behind', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)
    const qvacDir = path.dirname(workerDir)
    const uuid = '0f8e6c2a-3b1d-4e5f-9a7b-1c2d3e4f5a6b'
    const stale = [`.worker-${uuid}`, `.worker-scan-${uuid}`]
    writeFile(path.join(qvacDir, stale[0]!, 'worker', 'index.js'), 'half-written bundle')
    writeFile(path.join(qvacDir, stale[1]!, 'worker-scan', 'index.js'), 'half-written scan')
    const holdingBackup = `.worker-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d`
    writeFile(path.join(qvacDir, holdingBackup, 'worker.previous', 'index.js'), 'last good bundle')

    await bundleSdk({ projectRoot, configPath, quiet: true })

    const left = fs.readdirSync(qvacDir).filter((name) => name.startsWith('.'))
    assert.deepEqual(left, [holdingBackup])
  })

  it('keeps the scratch folders of a bundle that is still running', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)
    const running = await scratchFolderFor(workerDir)
    writeFile(path.join(running, 'index.js'), 'bundle being written')
    const exited = `.worker-0f8e6c2a-3b1d-4e5f-9a7b-1c2d3e4f5a6b`
    writeFile(path.join(path.dirname(workerDir), exited, 'worker', 'index.js'), 'half-written')
    const { pid } = spawnSync(process.execPath, ['-e', ''])
    writeFile(path.join(path.dirname(workerDir), exited, SCRATCH_OWNER_FILE), String(pid))

    await bundleSdk({ projectRoot, configPath, quiet: true })

    assert.equal(fs.readFileSync(path.join(running, 'index.js'), 'utf8'), 'bundle being written')
    assert.equal(fs.existsSync(path.join(path.dirname(workerDir), exited)), false)
  })

  it('leaves folders next to the output folder alone', async (t) => {
    const { projectRoot, configPath, workerDir } = fakeBundleSdkProject(t)
    const neighbours = [`${workerDir}.staging`, path.join(path.dirname(workerDir), 'worker-scan')]
    for (const neighbour of neighbours) writeFile(path.join(neighbour, 'keep.txt'), 'kept')

    await bundleSdk({ projectRoot, configPath, quiet: true })

    for (const neighbour of neighbours) {
      assert.equal(fs.readFileSync(path.join(neighbour, 'keep.txt'), 'utf8'), 'kept')
    }
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
        verify: false
      }),
      (error: unknown) => error instanceof BundleFailedError
    )
  })
})
