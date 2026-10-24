import test from 'brittle'
import fs from 'fs'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const require = createRequire(import.meta.url)
const PLUGIN_PATH = path.join(import.meta.dirname, '../src/electron-forge/index.cjs')

const QvacForgePlugin = require(PLUGIN_PATH)
const {
  createIgnore,
  diffAddons,
  detectTargetHosts,
  resolveHosts,
  runBundleAndVerify,
  QvacForgePluginError,
  setLogLevel
} = require(PLUGIN_PATH)

setLogLevel('off')

// ============================================
// diffAddons
// ============================================

test('diffAddons: required is subset → exclusions are the diff', (t) => {
  const installed = ['@qvac/llm-llamacpp', '@qvac/ocr-ggml', '@qvac/embed-llamacpp']
  const required = ['@qvac/llm-llamacpp']
  const result = diffAddons(installed, required).sort()
  t.alike(result, ['@qvac/embed-llamacpp', '@qvac/ocr-ggml'])
})

test('diffAddons: empty required → all installed are exclusions', (t) => {
  const installed = ['@qvac/llm-llamacpp', '@qvac/ocr-ggml']
  t.alike(diffAddons(installed, []).sort(), ['@qvac/llm-llamacpp', '@qvac/ocr-ggml'])
})

test('diffAddons: required matches all installed → no exclusions', (t) => {
  const installed = ['@qvac/llm-llamacpp']
  t.alike(diffAddons(installed, ['@qvac/llm-llamacpp']), [])
})

test('diffAddons: empty installed → no exclusions', (t) => {
  t.alike(diffAddons([], ['@qvac/llm-llamacpp']), [])
})

// ============================================
// createIgnore: composition with user ignore
// ============================================

test('createIgnore: composes with user function (user OR addon OR mobile prebuild OR out/)', (t) => {
  const userFn = (filePath: string) => filePath.includes('/.git/')
  const ignore = createIgnore(['@qvac/ocr-ggml'], userFn)

  t.is(typeof ignore, 'function', 'function input → function output')
  t.ok(ignore('/x/.git/HEAD'), 'user fn match')
  t.ok(ignore('/x/node_modules/@qvac/ocr-ggml/package.json'), 'excluded addon match')
  t.ok(
    ignore('/x/node_modules/anything/prebuilds/android-arm64/native.bare'),
    'android prebuild match'
  )
  t.ok(ignore('/x/node_modules/anything/prebuilds/ios-arm64/native.bare'), 'ios prebuild match')
  t.ok(
    ignore('/out/test-electron-app-darwin-arm64/foo.bin'),
    'out/ excluded in function-form too (parity with array form)'
  )
  t.absent(ignore('/x/node_modules/@qvac/llm-llamacpp/package.json'), 'non-excluded addon kept')
  t.absent(ignore('/x/index.js'), 'regular file kept')
})

test('createIgnore: composes with user array', (t) => {
  const userPattern = /^\/secret\//
  const ignore = createIgnore(['@qvac/ocr-ggml'], [userPattern])

  t.ok(Array.isArray(ignore), 'array input → array output')
  t.ok(
    ignore.some((re: RegExp) => re.source === userPattern.source),
    'user pattern preserved'
  )
  t.ok(
    ignore.some((re: RegExp) => re.test('/x/node_modules/@qvac/ocr-ggml/package.json')),
    'excluded addon pattern present'
  )
  t.ok(
    ignore.some((re: RegExp) => re.test('/x/node_modules/x/prebuilds/ios-arm64/native.bare')),
    'ios prebuild pattern present'
  )
  t.ok(
    ignore.some((re: RegExp) => re.test('/x/node_modules/x/prebuilds/android-arm64/native.bare')),
    'android prebuild pattern present'
  )
})

test('createIgnore: undefined existing → array form with no user patterns', (t) => {
  const ignore = createIgnore([], undefined)
  t.ok(Array.isArray(ignore))
  t.is(
    ignore.filter((re: unknown) => re instanceof RegExp).length,
    ignore.length,
    'all entries are regexes'
  )
})

test('createIgnore: empty exclusions still excludes mobile prebuilds', (t) => {
  const ignore = createIgnore([], undefined)
  t.ok(Array.isArray(ignore))
  t.ok(
    ignore.some((re: RegExp) => re.test('/x/node_modules/x/prebuilds/android-arm64/native.bare')),
    'mobile prebuild excluded even with no addon exclusions'
  )
})

// ============================================
// detectTargetHosts
// ============================================

test('detectTargetHosts: no flags → null (caller falls back to defaultHosts)', (t) => {
  t.is(detectTargetHosts({}, []), null)
  t.is(detectTargetHosts({ packagerConfig: {} }, []), null)
})

test('detectTargetHosts: --platform + --arch (=value form) → single host', (t) => {
  t.alike(detectTargetHosts({}, ['--platform=win32', '--arch=x64']), ['win32-x64'])
})

test('detectTargetHosts: --platform + --arch (space form) → single host', (t) => {
  t.alike(detectTargetHosts({}, ['--platform', 'linux', '--arch', 'arm64']), ['linux-arm64'])
})

test('detectTargetHosts: comma-separated --arch expands to multiple hosts', (t) => {
  t.alike(detectTargetHosts({}, ['--platform=darwin', '--arch=arm64,x64']), [
    'darwin-arm64',
    'darwin-x64'
  ])
})

test('detectTargetHosts: CLI overrides packagerConfig', (t) => {
  const cfg = { packagerConfig: { platform: 'darwin', arch: 'x64' } }
  t.alike(detectTargetHosts(cfg, ['--arch=arm64']), ['darwin-arm64'])
})

test('detectTargetHosts: only --arch given → uses host platform', (t) => {
  const result = detectTargetHosts({}, ['--arch=arm64'])
  t.alike(result, [`${process.platform}-arm64`])
})

// ============================================
// resolveHosts + runBundleAndVerify wiring
// ============================================

test('resolveHosts: explicit non-empty array wins', (t) => {
  t.alike(resolveHosts(['darwin-x64']), ['darwin-x64'])
  t.alike(resolveHosts(['linux-arm64', 'linux-x64']), ['linux-arm64', 'linux-x64'])
})

test('resolveHosts: null/undefined/empty falls back to host', (t) => {
  const expected = [`${process.platform}-${process.arch}`]
  t.alike(resolveHosts(null), expected)
  t.alike(resolveHosts(undefined), expected)
  t.alike(resolveHosts([]), expected)
})

function makeFakeCommands() {
  const calls: { bundleHosts: string[] | null; verifyHosts: string[] | null } = {
    bundleHosts: null,
    verifyHosts: null
  }
  return {
    calls,
    commands: {
      bundleSdk: async (opts: { hosts?: string[] }) => {
        calls.bundleHosts = opts.hosts ?? null
        return {
          bundlePath: '/fake/qvac/worker.bundle.js',
          plugins: [],
          addons: [],
          entryPaths: { worker: '/fake/qvac/worker.entry.mjs' },
          manifestPath: '/fake/qvac/addons.manifest.json'
        }
      },
      verifyBundle: async (opts: { hosts?: string[] }) => {
        calls.verifyHosts = opts.hosts ?? null
        return { issues: [], addons: [] }
      },
      hasErrors: () => false,
      formatVerifyBundleResult: () => ''
    }
  }
}

test('runBundleAndVerify: same resolved hosts threaded into bundleSdk and verifyBundle', async (t) => {
  const { commands, calls } = makeFakeCommands()
  await runBundleAndVerify(commands, '/fake/project', {
    configPath: null,
    hosts: ['darwin-x64']
  })
  t.alike(calls.bundleHosts, ['darwin-x64'], 'bundleSdk got the resolved hosts')
  t.alike(calls.verifyHosts, ['darwin-x64'], 'verifyBundle got the resolved hosts')
  t.alike(calls.bundleHosts, calls.verifyHosts, 'both commands receive the same hosts array')
})

test('runBundleAndVerify: defaults to host arch when hosts is null', async (t) => {
  const { commands, calls } = makeFakeCommands()
  await runBundleAndVerify(commands, '/fake/project', {
    configPath: null,
    hosts: null
  })
  const expected = [`${process.platform}-${process.arch}`]
  t.alike(calls.bundleHosts, expected, 'bundleSdk got host fallback')
  t.alike(calls.verifyHosts, expected, 'verifyBundle got host fallback')
})

test('runBundleAndVerify: narrowed and absent linkedHosts both survive reporting', async (t) => {
  const commands = {
    bundleSdk: async () => ({
      bundlePath: '/fake/qvac/worker.bundle.js',
      plugins: [],
      addons: [],
      entryPaths: { worker: '/fake/qvac/worker.entry.mjs' },
      manifestPath: '/fake/qvac/addons.manifest.json'
    }),
    verifyBundle: async () => ({
      issues: [],
      addons: [
        { name: 'bare-posix', version: '1.0.1', linkedHosts: [] },
        { name: 'bare-crypto', version: '1.15.3', linkedHosts: ['win32-x64'] },
        { name: 'bare-os', version: '3.9.3' }
      ]
    }),
    hasErrors: () => false,
    formatVerifyBundleResult: () => ''
  }
  const result = await runBundleAndVerify(commands, '/fake/project', {
    configPath: null,
    hosts: ['win32-x64', 'linux-x64']
  })
  t.ok(result.bundlePath, 'reporting an unlinked addon does not break the flow')
})

test('runBundleAndVerify: bundleSdk failure is wrapped in QvacForgePluginError', async (t) => {
  const commands = {
    bundleSdk: async () => {
      throw new Error('bare-pack exploded')
    },
    verifyBundle: async () => ({ issues: [], addons: [] }),
    hasErrors: () => false,
    formatVerifyBundleResult: () => ''
  }
  await t.exception(
    () =>
      runBundleAndVerify(commands, '/fake/project', {
        configPath: null,
        hosts: ['darwin-arm64']
      }),
    /bundleSdk failed: bare-pack exploded/
  )
})

// ============================================
// Forge plugin contract
// ============================================

test('QvacForgePlugin: loads on the installed @electron-forge/plugin-base', (t) => {
  // plugin-base 8 is ESM-only; the CJS plugin reaches it through require(esm).
  const { PluginBase } = require('@electron-forge/plugin-base')
  const plugin = new QvacForgePlugin()
  t.ok(plugin instanceof PluginBase)
  t.is(plugin.__isElectronForgePlugin, true, 'Forge recognizes the instance as a plugin')
  t.is(plugin.name, 'qvac')
  t.is(typeof plugin.getHooks().resolveForgeConfig, 'function')
})

// ============================================
// createPruneHook: Packager 18 and 19+ hook conventions
// ============================================

function makeBuildPath(t: { teardown: (fn: () => void) => void }) {
  const buildPath = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-forge-'))
  t.teardown(() => fs.rmSync(buildPath, { recursive: true, force: true }))
  for (const host of ['darwin-arm64', 'linux-x64']) {
    const dir = path.join(buildPath, 'node_modules', 'x', 'prebuilds', host)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'x.bare'), '')
  }
  const addonDir = path.join(buildPath, 'node_modules', '@qvac', 'ocr-ggml')
  fs.mkdirSync(addonDir, { recursive: true })
  fs.writeFileSync(path.join(addonDir, 'package.json'), '{}')
  return buildPath
}

function remaining(buildPath: string) {
  const nodeModules = path.join(buildPath, 'node_modules')
  return {
    prebuilds: fs.readdirSync(path.join(nodeModules, 'x', 'prebuilds')).sort(),
    addonKept: fs.existsSync(path.join(nodeModules, '@qvac', 'ocr-ggml'))
  }
}

test('createPruneHook: Packager 19+ object form prunes before the promise resolves', async (t) => {
  const hook = new QvacForgePlugin().createPruneHook(['@qvac/ocr-ggml'])
  const buildPath = makeBuildPath(t)

  await hook({ buildPath, electronVersion: '40.0.0', platform: 'linux', arch: 'x64' })

  t.alike(remaining(buildPath), { prebuilds: ['linux-x64'], addonKept: false })
})

test('createPruneHook: Packager 18 positional form prunes before calling done', async (t) => {
  const hook = new QvacForgePlugin().createPruneHook(['@qvac/ocr-ggml'])
  const buildPath = makeBuildPath(t)

  // Forge 7 runs afterPrune hooks through util.promisify with these args.
  await promisify(hook)(buildPath, '40.0.0', 'darwin', 'arm64')

  t.alike(remaining(buildPath), { prebuilds: ['darwin-arm64'], addonKept: false })
})

test('createPruneHook: failures reject the promise or reach done', async (t) => {
  const hook = new QvacForgePlugin().createPruneHook()

  // A missing buildPath fails with a native TypeError, which plain t.exception rethrows.
  await t.exception.all(hook({ platform: 'linux', arch: 'x64' }), /"path" argument/)
  await t.exception.all(promisify(hook)(undefined, '40.0.0', 'linux', 'x64'), /"path" argument/)
})

// ============================================
// QvacForgePluginError
// ============================================

test('QvacForgePluginError: trimmed stack for cleaner Forge unhandled-rejection', (t) => {
  const err = new QvacForgePluginError('boom')
  t.is(err.name, 'QvacForgePluginError')
  t.is(err.message, 'boom')
  t.is(
    err.stack,
    'QvacForgePluginError: boom',
    'stack is exactly name+message — Forge unhandled-rejection block stays focused'
  )
  t.ok(err instanceof Error)
})
