import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { bundleSdk } from '@/commands/bundle'
import { selectExportTarget, createSdkImportResolver } from '@/commands/bundle/resolve-sdk-import'
import { generateWorkerEntries, generateWorkerEntry } from '@/commands/bundle/entry-gen'
import { resolvePluginSpecifiers } from '@/commands/bundle/plugins'
import { getClientLogger } from '@/logging'
import {
  generateAddonsManifest,
  extractPackedString,
  extractBarePackHeader
} from '@/commands/bundle/manifest'

function fakeBundleSdkProject(t: { after: (fn: () => void) => void }) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-bundle-project-'))
  const sdkPath = path.join(projectRoot, 'external-sdk')
  const sdkDistPath = path.join(sdkPath, 'dist')
  const configPath = path.join(projectRoot, 'qvac.config.json')

  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  fs.mkdirSync(sdkDistPath, { recursive: true })
  fs.writeFileSync(
    path.join(sdkPath, 'package.json'),
    `${JSON.stringify({
      name: '@qvac/sdk',
      type: 'module',
      exports: {
        './worker-lifecycle': './dist/worker-lifecycle.js',
        './plugins': './dist/plugins.js',
        './logging': './dist/logging.js',
        './llamacpp-completion/plugin': './dist/llm-plugin.js'
      }
    })}\n`
  )
  fs.writeFileSync(path.join(sdkPath, 'bare-imports.json'), '{}\n')
  fs.writeFileSync(
    path.join(sdkDistPath, 'worker-lifecycle.js'),
    'export function initializeWorker() { return { hasRPCConfig: false } }\n' +
      'export function ensureRPCSetup() {}\n'
  )
  fs.writeFileSync(path.join(sdkDistPath, 'plugins.js'), 'export function registerPlugin() {}\n')
  fs.writeFileSync(
    path.join(sdkDistPath, 'logging.js'),
    'export function getServerLogger() { return { info() {} } }\n'
  )
  fs.writeFileSync(path.join(sdkDistPath, 'llm-plugin.js'), 'export const llmPlugin = {}\n')

  const inferenceDist = path.join(sdkPath, 'node_modules', '@qvac', 'inference', 'dist', 'plugins')
  fs.mkdirSync(inferenceDist, { recursive: true })
  fs.writeFileSync(
    path.join(sdkPath, 'node_modules', '@qvac', 'inference', 'package.json'),
    `${JSON.stringify({
      name: '@qvac/inference',
      type: 'module',
      exports: {
        './package': './package.json',
        './plugins': './dist/plugins/index.js'
      }
    })}\n`
  )
  fs.writeFileSync(path.join(inferenceDist, 'index.js'), 'export function registerPlugin() {}\n')

  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ plugins: ['@qvac/sdk/llamacpp-completion/plugin'] })}\n`
  )

  return {
    projectRoot,
    sdkPath,
    configPath,
    outputDir: path.join(projectRoot, 'qvac')
  }
}

describe('selectExportTarget', () => {
  it('returns a plain string target', () => {
    assert.equal(selectExportTarget('./dist/index.js'), './dist/index.js')
  })

  it('resolves the import condition', () => {
    assert.equal(selectExportTarget({ import: './dist/x.js' }), './dist/x.js')
  })

  it('prefers the bare condition over import', () => {
    assert.equal(
      selectExportTarget({ import: './dist/x.js', bare: './dist/x.bare.js' }),
      './dist/x.bare.js'
    )
  })

  it('descends into nested conditions', () => {
    assert.equal(selectExportTarget({ node: { import: './dist/node.js' } }), './dist/node.js')
  })

  it('returns null for missing or unknown-only conditions', () => {
    assert.equal(selectExportTarget(undefined), null)
    assert.equal(selectExportTarget({ types: './dist/x.d.ts' }), null)
  })
})

describe('createSdkImportResolver', () => {
  function fakeSdk(
    t: { after: (fn: () => void) => void },
    opts: { withInference?: boolean } = {}
  ): {
    realDir: string
    linkDir: string
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-sdk-import-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const realDir = path.join(root, 'real', 'sdk')
    fs.mkdirSync(realDir, { recursive: true })
    fs.writeFileSync(
      path.join(realDir, 'package.json'),
      JSON.stringify({
        name: '@qvac/sdk',
        exports: {
          './worker-lifecycle': { import: './dist/server/worker-lifecycle.js' },
          './plugins': { import: './dist/server/plugins/index.js' }
        }
      })
    )
    if (opts.withInference) {
      const inferenceDir = path.join(realDir, 'node_modules', '@qvac', 'inference')
      fs.mkdirSync(inferenceDir, { recursive: true })
      fs.writeFileSync(
        path.join(inferenceDir, 'package.json'),
        JSON.stringify({
          name: '@qvac/inference',
          exports: {
            './package': './package.json',
            './plugins': { import: './dist/plugins/index.js' }
          }
        })
      )
    }
    const linkDir = path.join(root, 'node_modules', '@qvac', 'sdk')
    fs.mkdirSync(path.dirname(linkDir), { recursive: true })
    fs.symlinkSync(realDir, linkDir)
    return { realDir, linkDir }
  }

  it('resolves an SDK subpath to a file URL anchored at the realpath, not the symlink', (t) => {
    const { realDir, linkDir } = fakeSdk(t)
    const resolve = createSdkImportResolver(linkDir, '@qvac/sdk')

    const expected = pathToFileURL(
      path.join(fs.realpathSync(realDir), 'dist', 'server', 'worker-lifecycle.js')
    ).href
    assert.equal(resolve('@qvac/sdk/worker-lifecycle'), expected)
    assert.ok(!resolve('@qvac/sdk/worker-lifecycle').includes('node_modules'))
  })

  it('passes through non-SDK specifiers unchanged', (t) => {
    const { linkDir } = fakeSdk(t)
    const resolve = createSdkImportResolver(linkDir, '@qvac/sdk')
    assert.equal(resolve('react'), 'react')
    assert.equal(resolve('my-pkg/plugin'), 'my-pkg/plugin')
  })

  it('leaves SDK subpaths that are not in exports unchanged', (t) => {
    const { linkDir } = fakeSdk(t)
    const resolve = createSdkImportResolver(linkDir, '@qvac/sdk')
    assert.equal(resolve('@qvac/sdk/not-exported'), '@qvac/sdk/not-exported')
  })

  it('does not anchor @qvac/inference subpaths even when inference is resolvable', (t) => {
    const { linkDir } = fakeSdk(t, { withInference: true })
    const resolve = createSdkImportResolver(linkDir, '@qvac/sdk')
    assert.equal(resolve('@qvac/inference/plugins'), '@qvac/inference/plugins')
  })

  it('leaves @qvac/inference specifiers unchanged', (t) => {
    const { linkDir } = fakeSdk(t)
    const resolve = createSdkImportResolver(linkDir, '@qvac/sdk')
    assert.equal(resolve('@qvac/inference/plugins'), '@qvac/inference/plugins')
  })
})

describe('generateWorkerEntry', () => {
  const tag = (specifier: string): string =>
    specifier.startsWith('@qvac/sdk') ? `RESOLVED:${specifier}` : specifier

  it('leaves RPC native imports out of a model-only worker', () => {
    const entry = generateWorkerEntry(['@qvac/sdk/nmtcpp-translation/plugin'], '@qvac/sdk')
    assert.doesNotMatch(entry, /rpc-server|RpcServerProvider/)
  })

  it('assembles a server-only worker with an explicit provider and no model plugin', () => {
    const plugins = resolvePluginSpecifiers(
      { plugins: [], rpcServerProvider: '@qvac/sdk/ggml-rpc-server/provider' },
      '@qvac/sdk',
      getClientLogger({ enableConsole: false })
    )
    assert.deepEqual(plugins, [])
    const { runtimeEntry, bundleEntry } = generateWorkerEntries(
      plugins,
      '@qvac/sdk',
      tag,
      '@qvac/sdk/ggml-rpc-server/provider'
    )
    assert.match(runtimeEntry, /from "@qvac\/sdk\/ggml-rpc-server\/provider"/)
    assert.match(bundleEntry, /from "RESOLVED:@qvac\/sdk\/ggml-rpc-server\/provider"/)
    assert.match(runtimeEntry, /registerRpcServerProvider\(rpcServerProvider\)/)
    assert.doesNotMatch(runtimeEntry, /registerPlugin\(/)
  })

  it('quotes custom provider specifiers as module strings', () => {
    const entry = generateWorkerEntry([], '@qvac/sdk', tag, 'custom"provider')
    assert.ok(entry.includes('from "custom\\"provider";'))
  })

  it('routes SDK imports through the resolver and registers plugins via @qvac/sdk/plugins', () => {
    const entry = generateWorkerEntry([], '@qvac/sdk', tag)
    assert.match(entry, /from "RESOLVED:@qvac\/sdk\/worker-lifecycle"/)
    assert.match(entry, /from "RESOLVED:@qvac\/sdk\/logging"/)
    assert.match(entry, /from "RESOLVED:@qvac\/sdk\/plugins"/)
  })

  it('routes builtin plugin imports through the resolver and keeps custom plugins', () => {
    const entry = generateWorkerEntry(
      ['@qvac/sdk/llamacpp-completion/plugin', 'my-pkg/plugin'],
      '@qvac/sdk',
      tag
    )
    assert.match(entry, /from "RESOLVED:@qvac\/sdk\/llamacpp-completion\/plugin"/)
    assert.match(entry, /from "my-pkg\/plugin"/)
  })

  it('defaults to an identity resolver (imports stay bare specifiers)', () => {
    const entry = generateWorkerEntry([], '@qvac/sdk')
    assert.match(entry, /from "@qvac\/sdk\/worker-lifecycle"/)
  })

  it('keeps the runtime entry relocatable while resolving the bundle entry', () => {
    const { runtimeEntry, bundleEntry } = generateWorkerEntries([], '@qvac/sdk', tag)

    assert.match(runtimeEntry, /from "@qvac\/sdk\/worker-lifecycle"/)
    assert.doesNotMatch(runtimeEntry, /RESOLVED:/)
    assert.match(bundleEntry, /from "RESOLVED:@qvac\/sdk\/worker-lifecycle"/)
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
    function linkDependency(dependency: string, from: string, optional = false) {
      const target = path.join(projectRoot, 'node_modules', dependency)
      if (fs.existsSync(target)) return
      let parent = from
      let source = path.join(parent, 'node_modules', dependency)
      while (!fs.existsSync(source) && parent !== path.dirname(parent)) {
        parent = path.dirname(parent)
        source = path.join(parent, 'node_modules', dependency)
      }
      if (optional && !fs.existsSync(source)) return
      source = fs.realpathSync(source)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.symlinkSync(source, target, 'junction')
      const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
      for (const child of Object.keys(pkg.dependencies ?? {})) linkDependency(child, source)
      for (const child of Object.keys({ ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
        linkDependency(child, source, true)
      }
    }
    // Include the selected model addon, its language detector, and runtime dependencies.
    for (const dependency of [
      ...Object.keys(manifest.dependencies),
      '@qvac/translation-nmtcpp',
      '@qvac/langdetect-text'
    ]) {
      linkDependency(dependency, inferenceRoot)
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
    execFileSync(
      packBin,
      ['--host', `${process.platform}-${process.arch}`, '--linked', '--out', bundlePath, entryPath],
      { stdio: 'pipe' }
    )
    const header = extractBarePackHeader(extractPackedString(fs.readFileSync(bundlePath, 'utf8')))
    assert.doesNotMatch(JSON.stringify(header.resolutions), /ggml-rpc-server|rpc\/ggml-provider/)
    const { addons } = await generateAddonsManifest({
      bundlePath,
      outputDir: projectRoot,
      projectRoot,
      logger: getClientLogger({ enableConsole: false })
    })
    assert.ok(addons.some((addon) => addon.includes('translation-nmtcpp')))
    assert.ok(addons.every((addon) => !addon.includes('ggml-rpc-server')))
  })
})

describe('bundleSdk worker entries', () => {
  it('uses resolved imports for bare-pack but writes a relocatable runtime entry', async (t) => {
    const { projectRoot, sdkPath, configPath, outputDir } = fakeBundleSdkProject(t)

    await bundleSdk({
      projectRoot,
      sdkPath,
      configPath,
      hosts: [`${process.platform}-${process.arch}`],
      quiet: true
    })

    const runtimeEntry = fs.readFileSync(path.join(outputDir, 'worker.entry.mjs'), 'utf8')
    assert.match(runtimeEntry, /from "@qvac\/sdk\/worker-lifecycle"/)
    assert.doesNotMatch(runtimeEntry, new RegExp(pathToFileURL(sdkPath).href))
    assert.ok(fs.existsSync(path.join(outputDir, 'worker.bundle.js')))
    assert.ok(!fs.existsSync(path.join(outputDir, 'worker.bundle.entry.mjs')))
  })

  it('removes the temporary bundle entry when bare-pack fails', async (t) => {
    const { projectRoot, sdkPath, configPath, outputDir } = fakeBundleSdkProject(t)
    fs.writeFileSync(configPath, `${JSON.stringify({ plugins: ['missing-package/plugin'] })}\n`)

    await assert.rejects(
      bundleSdk({
        projectRoot,
        sdkPath,
        configPath,
        hosts: [`${process.platform}-${process.arch}`],
        quiet: true
      })
    )

    assert.ok(!fs.existsSync(path.join(outputDir, 'worker.bundle.entry.mjs')))
  })
})
