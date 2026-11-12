import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLimiter } from '@/commands/verify/addon-source'
import {
  parseBareKitPins,
  parseBareKitVersion,
  parseBareVersion,
  resolveBareKitRuntime
} from '@/commands/verify/bare-kit-runtime'
import {
  formatOverrideSnippet,
  pickOverrideVersion,
  type PackageMetadata
} from '@/commands/verify/engines-advice'
import { formatVerifyBundleResult, hasErrors, verifyBundle } from '@/commands/verify/index'
import { writeBundleFile } from './fixtures/bundle-file'
import { linkDependency } from './fixtures/link-dependency'

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-verify-engines-')))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function writePackage(projectRoot: string, relDir: string, body: Record<string, unknown>): string {
  const dir = path.join(projectRoot, relDir)
  writeFile(path.join(dir, 'package.json'), JSON.stringify(body, null, 2))
  return dir
}

function writePrebuilds(packageRoot: string, hosts: string[]): void {
  for (const host of hosts) writeFile(path.join(packageRoot, 'prebuilds', host, 'native.bare'), '')
}

/** The Bare Kit pins in the shape of bare-stow's `lib/target/bare-kit.js`. */
function bareKitTarget(pins: { kotlin?: string; swift?: string }): string {
  const lines = ["exports.name = 'bare-kit'", '']
  if (pins.swift !== undefined) {
    lines.push(
      'const bareKitSwift = {',
      "  url: 'https://github.com/holepunchto/bare-kit-swift',",
      `  from: '${pins.swift}',`,
      "  products: ['BareKit']",
      '}',
      ''
    )
  }
  if (pins.kotlin !== undefined) {
    lines.push(
      'const bareKitKotlin = {',
      `  'com.github.holepunchto.bare-kit-kotlin:bare-kit-kotlin': 'v${pins.kotlin}'`,
      '}',
      ''
    )
  }
  return lines.join('\n')
}

/** A bare-stow package whose Bare Kit pins the resolver reads. */
function writeBareStow(dir: string, pins: { kotlin?: string; swift?: string }): string {
  const bareStowDir = path.join(dir, 'bare-stow')
  writeFile(path.join(bareStowDir, 'lib', 'target', 'bare-kit.js'), bareKitTarget(pins))
  return bareStowDir
}

/** bare-kit-kotlin 0.2.2 and bare-kit-swift 2.2.0 are both built from bare-kit 3.0.1, Bare 1.36.2. */
const CURRENT_PINS = { kotlin: '0.2.2', swift: '2.2.0' }

function failingFetch(): (url: string) => Promise<string> {
  return () => Promise.reject(new Error('unexpected network request'))
}

/** GitHub CMakeLists.txt files for bindings missing from the built-in tables. */
function fakeGitHub(files: Record<string, string>, requested: string[] = []) {
  return (url: string) => {
    requested.push(url)
    const match = Object.entries(files).find(([fragment]) => url.includes(fragment))
    return match === undefined
      ? Promise.reject(new Error(`unexpected ${url}`))
      : Promise.resolve(match[1])
  }
}

const BARE_TYPE_METADATA: PackageMetadata = {
  versions: {
    '1.0.8': { engines: { bare: '>=1.2.0' } },
    '1.1.0': { engines: { bare: '>=1.2.0' } },
    '1.1.1': { engines: { bare: '>=1.2.0' } },
    '1.2.0': { engines: { bare: '>=1.40.0' } },
    '1.4.0': { engines: { bare: '>=1.40.0' } },
    '2.0.0-rc.1': {}
  }
}

/**
 * A phone app whose Bare Kit runs Bare 1.36.2 while the tree pulls in
 * bare-type 1.4.0 (engines.bare >=1.40.0 unless given) through bare-inspect.
 */
function writeMobileProject(
  projectRoot: string,
  options: { hosts: string[]; enginesBare?: string }
): string {
  writePackage(projectRoot, '.', { name: 'app', version: '1.0.0' })
  writeFile(path.join(projectRoot, 'package-lock.json'), '{}')
  writePackage(projectRoot, 'node_modules/bare-inspect', {
    name: 'bare-inspect',
    version: '3.1.10',
    dependencies: { 'bare-type': '^1.0.0' }
  })
  const bareType = writePackage(projectRoot, 'node_modules/bare-type', {
    name: 'bare-type',
    version: '1.4.0',
    addon: true,
    engines: { bare: options.enginesBare ?? '>=1.40.0' }
  })
  writePrebuilds(bareType, options.hosts)
  return writeBareStow(projectRoot, CURRENT_PINS)
}

/** A bare-sidecar whose Bare is `bare`, which desktop hosts are checked against. */
function writeSidecar(projectRoot: string, bare: string) {
  const dir = writePackage(projectRoot, 'node_modules/bare-sidecar', {
    name: 'bare-sidecar',
    version: '0.5.15'
  })
  writeFile(path.join(dir, 'versions.json'), JSON.stringify({ bare }))
}

function writeBareBundle(bundlePath: string, main: string, resolutions: Record<string, unknown>) {
  writeBundleFile(bundlePath, { main, resolutions })
}

/**
 * A bundle whose only addon, `ios-only`, links on iOS and resolves to a JS
 * stub elsewhere. `linkedOnDesktop` makes it link on darwin as well.
 */
function writeMixedHostBundle(projectRoot: string, options: { linkedOnDesktop: boolean }) {
  const pkg = '/node_modules/ios-only/package.json'
  const binding: Record<string, string> = { ios: 'linked:ios-only.1.0.0.framework/ios-only.1.0.0' }
  if (options.linkedOnDesktop) binding['darwin'] = 'linked:ios-only.1.0.0.framework/ios-only.1.0.0'
  binding['default'] = '/node_modules/ios-only/stub.js'

  const bundlePath = path.join(projectRoot, 'qvac', 'worker', 'index.bundle')
  writeBareBundle(bundlePath, '/app/entry.js', {
    '/app/entry.js': { 'ios-only': '/node_modules/ios-only/index.js' },
    '/node_modules/ios-only/index.js': {
      '#package': pkg,
      './binding': '/node_modules/ios-only/binding.js'
    },
    '/node_modules/ios-only/binding.js': { '#package': pkg, '.': binding },
    '/node_modules/ios-only/stub.js': { '#package': pkg },
    [pkg]: {}
  })
  // Bare 1.36.2 does not satisfy the addon's engines.bare.
  const addon = writePackage(projectRoot, 'node_modules/ios-only', {
    name: 'ios-only',
    version: '1.0.0',
    addon: true,
    engines: { bare: '>=1.40.0' }
  })
  writePrebuilds(addon, ['ios-arm64', 'android-arm64', 'darwin-arm64'])
  return { bundlePath, bareStowDir: writeBareStow(projectRoot, CURRENT_PINS) }
}

describe('Bare Kit CMakeLists and bare-stow pin parsing', () => {
  it('reads the bare-kit version a binding fetches', () => {
    assert.equal(parseBareKitVersion('fetch_package("github:holepunchto/bare-kit@3.0.1")'), '3.0.1')
  })

  it('reads the Bare version bare-kit fetches', () => {
    assert.equal(
      parseBareVersion('fetch_package("github:holepunchto/bare@1.31.2" SOURCE_DIR bare)'),
      '1.31.2'
    )
    assert.equal(parseBareVersion('fetch_package("github:holepunchto/bare@1.29.4")'), '1.29.4')
    assert.equal(parseBareVersion('fetch_package("github:holepunchto/bare-kit@3.0.1")'), null)
  })

  it('returns null when CMakeLists.txt names no version', () => {
    assert.equal(parseBareKitVersion('project(bare_kit_kotlin)'), null)
    assert.equal(parseBareVersion('project(bare_kit)'), null)
  })

  it('reads the bare-kit-kotlin and bare-kit-swift pins', () => {
    assert.deepEqual(parseBareKitPins(bareKitTarget(CURRENT_PINS)), {
      android: '0.2.2',
      ios: '2.2.0'
    })
    assert.deepEqual(parseBareKitPins("exports.name = 'bare-kit'"), { android: null, ios: null })
  })
})

describe('resolveBareKitRuntime', () => {
  it('resolves Android from the built-in tables without a network request', async () => {
    await withTempDir(async (dir) => {
      const progress: string[] = []
      const resolution = await resolveBareKitRuntime({
        platform: 'android',
        bareStowDir: writeBareStow(dir, CURRENT_PINS),
        fetchText: failingFetch(),
        onProgress: (message) => progress.push(message)
      })
      assert.ok(resolution.resolved)
      assert.equal(resolution.runtime.version, '1.36.2')
      assert.equal(resolution.runtime.source, 'bare-kit-kotlin')
      assert.equal(resolution.runtime.packageVersion, '0.2.2')
      assert.match(
        resolution.runtime.detail,
        /bare-kit-kotlin 0\.2\.2, built from bare-kit 3\.0\.1/
      )
      assert.deepEqual(progress, [])
    })
  })

  it('resolves iOS from the built-in tables at the pinned Swift version', async () => {
    await withTempDir(async (dir) => {
      const resolution = await resolveBareKitRuntime({
        platform: 'ios',
        bareStowDir: writeBareStow(dir, CURRENT_PINS),
        fetchText: failingFetch()
      })
      assert.ok(resolution.resolved)
      assert.equal(resolution.runtime.version, '1.36.2')
      assert.equal(resolution.runtime.source, 'bare-kit-swift')
      assert.equal(resolution.runtime.packageVersion, '2.2.0')
      assert.match(resolution.runtime.detail, /bare-kit-swift 2\.2\.0, built from/)
    })
  })

  it('reads the pins of the bare-stow the SDK resolves', async () => {
    const resolution = await resolveBareKitRuntime({
      platform: 'android',
      network: false,
      fetchText: failingFetch()
    })
    assert.ok(resolution.resolved)
    assert.equal(resolution.runtime.source, 'bare-kit-kotlin')
  })

  it('looks up a binding newer than the table on GitHub and reports it first', async () => {
    await withTempDir(async (dir) => {
      const requested: string[] = []
      const progress: string[] = []
      const resolution = await resolveBareKitRuntime({
        platform: 'android',
        bareStowDir: writeBareStow(dir, { kotlin: '9.0.0' }),
        onProgress: (message) => progress.push(message),
        fetchText: fakeGitHub(
          {
            '/bare-kit-kotlin/v9.0.0/': 'fetch_package("github:holepunchto/bare-kit@9.1.0")',
            '/bare-kit/v9.1.0/': 'fetch_package("github:holepunchto/bare@1.40.0")'
          },
          requested
        )
      })
      assert.ok(resolution.resolved)
      assert.equal(resolution.runtime.version, '1.40.0')
      assert.match(resolution.runtime.detail, /bare-kit 9\.1\.0, looked up on GitHub/)
      assert.equal(requested.length, 2)
      assert.equal(progress.length, 1)
      assert.match(progress[0]!, /bare-kit-kotlin@9\.0\.0/)
    })
  })

  it('looks up a binding older than the newest table entry that the table lacks', async () => {
    await withTempDir(async (dir) => {
      const requested: string[] = []
      const resolution = await resolveBareKitRuntime({
        platform: 'android',
        bareStowDir: writeBareStow(dir, { kotlin: '0.0.1' }),
        fetchText: fakeGitHub(
          { '/bare-kit-kotlin/v0.0.1/': 'fetch_package("github:holepunchto/bare-kit@3.0.1")' },
          requested
        )
      })
      assert.ok(resolution.resolved)
      assert.equal(resolution.runtime.version, '1.36.2')
      assert.match(resolution.runtime.detail, /bare-kit 3\.0\.1, looked up on GitHub/)
      assert.equal(requested.length, 1)
    })
  })

  it('reports an older binding the table lacks as not in the table when offline', async () => {
    await withTempDir(async (dir) => {
      const resolution = await resolveBareKitRuntime({
        platform: 'android',
        bareStowDir: writeBareStow(dir, { kotlin: '0.0.1' }),
        network: false,
        fetchText: failingFetch()
      })
      assert.equal(resolution.resolved, false)
      if (!resolution.resolved) {
        assert.match(resolution.error.reason, /bare-kit-kotlin@0\.0\.1 is not in the built-in/)
      }
    })
  })

  it('stays offline when network is disabled', async () => {
    await withTempDir(async (dir) => {
      const resolution = await resolveBareKitRuntime({
        platform: 'ios',
        bareStowDir: writeBareStow(dir, { swift: '9.0.0' }),
        network: false,
        fetchText: failingFetch()
      })
      assert.equal(resolution.resolved, false)
      if (!resolution.resolved) {
        assert.match(resolution.error.reason, /bare-kit-swift@9\.0\.0 is not in the built-in/)
        assert.match(resolution.error.reason, /network lookups are disabled/)
      }
    })
  })

  it('names the bare-stow file when it pins no binding for the platform', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeBareStow(dir, { swift: '2.2.0' })
      const resolution = await resolveBareKitRuntime({ platform: 'android', bareStowDir })
      assert.equal(resolution.resolved, false)
      if (!resolution.resolved) {
        const target = path.join(bareStowDir, 'lib', 'target', 'bare-kit.js')
        assert.ok(resolution.error.reason.includes(`${target} pins no bare-kit-kotlin version`))
        assert.deepEqual(resolution.error.triedPaths, [target])
      }
    })
  })
})

describe('pickOverrideVersion', () => {
  it('picks the newest release that runs on the runtime and satisfies every parent', () => {
    assert.equal(pickOverrideVersion(BARE_TYPE_METADATA, '1.29.4', ['1.4.0'], ['^1.0.0']), '1.1.1')
  })

  it('falls back to the installed major when a parent range cannot be met', () => {
    assert.equal(
      pickOverrideVersion(BARE_TYPE_METADATA, '1.29.4', ['1.4.0'], ['^1.0.0', '^1.3.0']),
      '1.1.1'
    )
  })

  it('returns null when no release runs on the runtime', () => {
    assert.equal(pickOverrideVersion(BARE_TYPE_METADATA, '1.1.0', ['1.4.0'], []), null)
  })

  it('returns null when no compatible release is accepted by any parent', () => {
    const metadata: PackageMetadata = {
      versions: {
        '0.0.0': {},
        '0.19.0': { engines: { bare: '^1.28.0' } },
        '0.20.0': { engines: { bare: '^1.30.3' } }
      }
    }
    assert.equal(pickOverrideVersion(metadata, '1.29.4', ['0.20.0'], ['^0.20.0']), null)
  })

  it('stays on the installed release line when no parent is known', () => {
    assert.equal(pickOverrideVersion(BARE_TYPE_METADATA, '1.29.4', ['1.4.0'], []), '1.1.1')
    const metadata: PackageMetadata = {
      versions: { '0.19.0': {}, '0.20.0': { engines: { bare: '^1.30.3' } } }
    }
    assert.equal(pickOverrideVersion(metadata, '1.29.4', ['0.20.0'], []), null)
  })
})

describe('formatOverrideSnippet', () => {
  it('scopes the override to the parent for each package manager', () => {
    assert.deepEqual(
      JSON.parse(formatOverrideSnippet('npm', 'bare-type', '1.1.1', ['bare-inspect'])),
      {
        overrides: { 'bare-inspect': { 'bare-type': '1.1.1' } }
      }
    )
    assert.deepEqual(
      JSON.parse(formatOverrideSnippet('pnpm', 'bare-type', '1.1.1', ['bare-inspect'])),
      {
        pnpm: { overrides: { 'bare-inspect>bare-type': '1.1.1' } }
      }
    )
    assert.deepEqual(
      JSON.parse(formatOverrideSnippet('yarn', 'bare-type', '1.1.1', ['bare-inspect'])),
      {
        resolutions: { 'bare-inspect/bare-type': '1.1.1' }
      }
    )
  })

  it('uses a top-level override for bun and when no parent is known', () => {
    assert.deepEqual(
      JSON.parse(formatOverrideSnippet('bun', 'bare-type', '1.1.1', ['bare-inspect'])),
      {
        overrides: { 'bare-type': '1.1.1' }
      }
    )
    assert.deepEqual(JSON.parse(formatOverrideSnippet('npm', 'bare-type', '1.1.1', [])), {
      overrides: { 'bare-type': '1.1.1' }
    })
  })
})

describe('createLimiter', () => {
  it('never runs more than the limit at once', async () => {
    const limit = createLimiter(3)
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 20 }, () =>
        limit(async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 1))
          active--
        })
      )
    )
    assert.equal(peak, 3)
  })
})

describe('verifyBundle engines.bare against the phone runtimes', () => {
  it('checks phone hosts against Bare Kit and desktop hosts against bare-sidecar', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, { hosts: ['android-arm64', 'darwin-arm64'] })
      writeSidecar(dir, '1.40.0')
      const progress: string[] = []
      const fetched: string[] = []
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64', 'darwin-arm64'],
        bareStowDir,
        onProgress: (message) => progress.push(message),
        fetchText: failingFetch(),
        fetchPackageMetadata: (name) => {
          fetched.push(name)
          return Promise.resolve(BARE_TYPE_METADATA)
        }
      })

      assert.ok(hasErrors(result))
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.match(mismatches[0]!.message, /runtime is 1\.36\.2 \(from bare-kit-kotlin/)

      assert.deepEqual(
        result.runtimes.map(({ platform, hosts, resolution }) => ({
          platform,
          hosts,
          version: resolution.resolved ? resolution.runtime.version : null
        })),
        [
          { platform: 'android', hosts: ['android-arm64'], version: '1.36.2' },
          { platform: 'desktop', hosts: ['darwin-arm64'], version: '1.40.0' }
        ]
      )

      assert.deepEqual(fetched, ['bare-type'])
      assert.equal(result.advice.length, 1)
      const advice = result.advice[0]!
      assert.deepEqual(advice.hosts, ['android-arm64'])
      assert.equal(advice.requiredBare, '1.40.0')
      assert.equal(advice.packageManager, 'npm')
      assert.equal(advice.overrides[0]?.version, '1.1.1')
      assert.deepEqual(advice.overrides[0]?.parents, [
        { name: 'bare-inspect', range: '^1.0.0', satisfied: true }
      ])

      assert.ok(progress.some((message) => message.startsWith('Scanning ')))
      assert.ok(progress.some((message) => message.startsWith('Looking up releases of bare-type')))

      const text = formatVerifyBundleResult(result)
      assert.match(
        text,
        /bare-type@1\.4\.0 requires bare >=1\.40\.0, runtime is 1\.36\.2 on android-arm64/
      )
      assert.match(text, /Requires: bare-type@1\.4\.0 needs Bare >=1\.40\.0/)
      assert.match(text, /Override \(bare-type\): pin 1\.4\.0 -> 1\.1\.1/)
      assert.match(text, /"overrides": \{ "bare-type": "1\.1\.1" \}/)
      assert.match(text, /bare-stow pins a Bare Kit with Bare 1\.40\.0 or newer/)
      assert.doesNotMatch(text, /react-native-bare-kit/)
    })
  })

  it('checks each phone platform against its own runtime and advises per platform', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, { hosts: ['android-arm64', 'ios-arm64'], enginesBare: '>=1.35.0' })
      const bareStowDir = writeBareStow(dir, { kotlin: '9.0.0', swift: '9.0.0' })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64', 'ios-arm64'],
        bareStowDir,
        fetchText: fakeGitHub({
          '/bare-kit-kotlin/v9.0.0/': 'fetch_package("github:holepunchto/bare-kit@9.1.0")',
          '/bare-kit-swift/v9.0.0/': 'fetch_package("github:holepunchto/bare-kit@9.2.0")',
          '/bare-kit/v9.1.0/': 'fetch_package("github:holepunchto/bare@1.40.0")',
          '/bare-kit/v9.2.0/': 'fetch_package("github:holepunchto/bare@1.30.0")'
        }),
        fetchPackageMetadata: () => Promise.resolve(BARE_TYPE_METADATA)
      })

      assert.deepEqual(
        result.runtimes.map(({ platform, resolution }) => [
          platform,
          resolution.resolved ? resolution.runtime.version : null
        ]),
        [
          ['android', '1.40.0'],
          ['ios', '1.30.0']
        ]
      )
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.deepEqual(mismatches[0]!.hosts, ['ios-arm64'])
      assert.match(mismatches[0]!.message, /from bare-kit-swift/)
      assert.deepEqual(
        result.advice.map((advice) => advice.hosts),
        [['ios-arm64']]
      )
    })
  })

  it('checks an addon a bundle links on iOS against the iOS runtime only', async () => {
    await withTempDir(async (dir) => {
      const { bundlePath, bareStowDir } = writeMixedHostBundle(dir, { linkedOnDesktop: false })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['android-arm64', 'ios-arm64'],
        bareStowDir,
        network: false
      })
      assert.deepEqual(
        result.runtimes.map(({ platform, hosts }) => [platform, hosts]),
        [
          ['android', ['android-arm64']],
          ['ios', ['ios-arm64']]
        ]
      )
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.deepEqual(mismatches[0]!.hosts, ['ios-arm64'])
      assert.match(mismatches[0]!.message, /runtime is 1\.36\.2 \(from bare-kit-swift/)
    })
  })

  it('scopes the override when another dependent needs the current version', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, { hosts: ['android-arm64'] })
      writePackage(dir, 'node_modules/bare-structured-clone', {
        name: 'bare-structured-clone',
        version: '2.0.1',
        dependencies: { 'bare-type': '^1.3.0' }
      })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64'],
        bareStowDir,
        fetchText: failingFetch(),
        fetchPackageMetadata: () => Promise.resolve(BARE_TYPE_METADATA)
      })
      const override = result.advice[0]?.overrides[0]
      assert.equal(override?.version, '1.1.1')
      assert.deepEqual(JSON.parse(override?.snippet ?? 'null'), {
        overrides: { 'bare-inspect': { 'bare-type': '1.1.1' } }
      })
      assert.match(
        formatVerifyBundleResult(result),
        /bare-structured-clone \(\^1\.3\.0\) does not accept 1\.1\.1/
      )
    })
  })

  it('passes when the Bare Kit Bare satisfies every engines.bare', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, {
        hosts: ['android-arm64', 'ios-arm64'],
        enginesBare: '>=1.32.0'
      })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64', 'ios-arm64'],
        bareStowDir,
        fetchText: failingFetch(),
        fetchPackageMetadata: () => Promise.reject(new Error('unexpected registry request'))
      })
      assert.equal(hasErrors(result), false)
      assert.deepEqual(result.advice, [])
    })
  })

  it('reports non-addon packages that declare engines.bare', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, {
        hosts: ['android-arm64'],
        enginesBare: '>=1.32.0'
      })
      writePackage(dir, 'node_modules/bare-new-api', {
        name: 'bare-new-api',
        version: '2.0.0',
        engines: { bare: '>=1.40.0' }
      })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64'],
        bareStowDir,
        network: false
      })
      const mismatch = result.issues.find((issue) => issue.code === 'engines-mismatch')
      assert.ok(mismatch)
      assert.match(mismatch.message, /bare-new-api@2\.0\.0 requires bare >=1\.40\.0/)
      assert.equal(result.advice[0]?.overrides[0]?.lookupSkipped, true)
      assert.match(formatVerifyBundleResult(result), /without --offline/)
    })
  })

  it('makes no network request when network is disabled', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, { hosts: ['android-arm64'] })
      const progress: string[] = []
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64'],
        bareStowDir,
        network: false,
        onProgress: (message) => progress.push(message),
        fetchText: failingFetch(),
        fetchPackageMetadata: () => Promise.reject(new Error('unexpected registry request'))
      })
      assert.ok(hasErrors(result))
      assert.equal(result.advice[0]?.overrides[0]?.version, null)
      assert.ok(progress.every((message) => !message.startsWith('Looking up releases of')))
    })
  })

  it('does not check an addon that only desktop hosts link', async () => {
    await withTempDir(async (dir) => {
      const { bundlePath, bareStowDir } = writeMixedHostBundle(dir, { linkedOnDesktop: true })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['android-arm64', 'darwin-arm64'],
        bareStowDir,
        network: false
      })
      assert.deepEqual(
        result.addons.map((addon) => addon.linkedHosts),
        [['darwin-arm64']]
      )
      assert.equal(
        result.issues.some((issue) => issue.code === 'abi-mismatch'),
        false
      )
    })
  })

  it('checks an addon once against the iOS runtime when iOS and desktop hosts link it', async () => {
    await withTempDir(async (dir) => {
      const { bundlePath, bareStowDir } = writeMixedHostBundle(dir, { linkedOnDesktop: true })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['ios-arm64', 'darwin-arm64'],
        bareStowDir,
        network: false
      })
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.match(mismatches[0]!.message, /runtime is 1\.36\.2 \(from bare-kit-swift/)
    })
  })

  it('checks desktop hosts against the Bare of the project bare-sidecar', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, { hosts: ['darwin-arm64'] })
      writeSidecar(dir, '1.36.2')
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        bareStowDir,
        network: false
      })
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.match(
        mismatches[0]!.message,
        /runtime is 1\.36\.2 \(from bare-sidecar: bare-sidecar 0\.5\.15/
      )
      assert.deepEqual(result.advice, [])
    })
  })

  it('checks desktop hosts against bare-kit-kotlin when the desktop runs Bare Kit', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, { hosts: ['darwin-arm64'] })
      writeSidecar(dir, '1.40.0')
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        desktopRuntime: 'bare-kit-kotlin',
        bareStowDir,
        network: false
      })
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.match(mismatches[0]!.message, /runtime is 1\.36\.2 \(from bare-kit-kotlin/)
    })
  })

  it('checks desktop hosts against the bare-sidecar pear-runtime resolves', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, { hosts: ['darwin-arm64'] })
      writeSidecar(dir, '1.40.0')
      writePackage(dir, 'node_modules/pear-runtime', { name: 'pear-runtime', version: '1.3.1' })
      const nested = writePackage(dir, 'node_modules/pear-runtime/node_modules/bare-sidecar', {
        name: 'bare-sidecar',
        version: '0.5.2'
      })
      writeFile(path.join(nested, 'versions.json'), JSON.stringify({ bare: '1.36.2' }))
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        desktopRuntime: 'pear-runtime',
        bareStowDir,
        network: false
      })
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.match(
        mismatches[0]!.message,
        /runtime is 1\.36\.2 \(from bare-sidecar: bare-sidecar 0\.5\.2/
      )
    })
  })

  it('checks a bundle stamped for pear-runtime against the bare-sidecar pear-runtime resolves', async () => {
    await withTempDir(async (dir) => {
      const { bundlePath, bareStowDir } = writeMixedHostBundle(dir, { linkedOnDesktop: true })
      writeFile(
        path.join(path.dirname(bundlePath), 'package.json'),
        JSON.stringify({ name: 'qvac-worker', qvacTarget: 'pear-runtime' })
      )
      writeSidecar(dir, '1.40.0')
      writePackage(dir, 'node_modules/pear-runtime', { name: 'pear-runtime', version: '1.3.1' })
      const nested = writePackage(dir, 'node_modules/pear-runtime/node_modules/bare-sidecar', {
        name: 'bare-sidecar',
        version: '0.5.2'
      })
      writeFile(path.join(nested, 'versions.json'), JSON.stringify({ bare: '1.36.2' }))

      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['darwin-arm64'],
        bareStowDir,
        network: false
      })
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.match(
        mismatches[0]!.message,
        /runtime is 1\.36\.2 \(from bare-sidecar: bare-sidecar 0\.5\.2/
      )
    })
  })

  it('checks a Kotlin desktop bundle against bare-kit-kotlin from the target recorded at its harness root', async () => {
    await withTempDir(async (dir) => {
      const { bundlePath: written, bareStowDir } = writeMixedHostBundle(dir, {
        linkedOnDesktop: true
      })
      const harnessRoot = path.join(dir, 'jvm', 'worker')
      const bundlePath = path.join(harnessRoot, 'src', 'main', 'resources', 'com', 'example')
      fs.mkdirSync(bundlePath, { recursive: true })
      fs.renameSync(written, path.join(bundlePath, 'index.bundle'))
      writeFile(
        path.join(harnessRoot, 'qvac-bundle.json'),
        JSON.stringify({ qvacTarget: 'bare-kit' })
      )
      writeSidecar(dir, '1.40.0')

      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(bundlePath, 'index.bundle'),
        hosts: ['darwin-arm64'],
        bareStowDir,
        network: false
      })
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.match(mismatches[0]!.message, /runtime is 1\.36\.2 \(from bare-kit-kotlin/)
    })
  })

  it('finds the bare-sidecar next to a pnpm-linked pear-runtime', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, { hosts: ['darwin-arm64'] })
      writeSidecar(dir, '1.40.0')
      const store = path.join(dir, 'node_modules', '.pnpm', 'pear-runtime@1.3.1')
      writePackage(store, 'node_modules/pear-runtime', { name: 'pear-runtime', version: '1.3.1' })
      const sibling = writePackage(store, 'node_modules/bare-sidecar', {
        name: 'bare-sidecar',
        version: '0.5.2'
      })
      writeFile(path.join(sibling, 'versions.json'), JSON.stringify({ bare: '1.36.2' }))
      linkDependency(dir, 'pear-runtime', store)

      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        desktopRuntime: 'pear-runtime',
        bareStowDir,
        network: false
      })
      const desktop = result.runtimes.find((runtime) => runtime.platform === 'desktop')
      assert.equal(
        desktop?.resolution.resolved ? desktop.resolution.runtime.packageVersion : null,
        '0.5.2'
      )
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.match(mismatches[0]!.message, /runtime is 1\.36\.2/)
    })
  })

  it('reports the desktop Bare as unknown for pear-runtime when it is not installed', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, { hosts: ['darwin-arm64'] })
      writeSidecar(dir, '1.40.0')
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        desktopRuntime: 'pear-runtime',
        bareStowDir,
        network: false
      })
      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['unknown-runtime-version']
      )
      const desktop = result.runtimes.find((runtime) => runtime.platform === 'desktop')
      assert.match(
        desktop?.resolution.resolved === false ? desktop.resolution.error.reason : '',
        /pear-runtime is not installed/
      )
    })
  })

  it('reports the desktop Bare as unknown without bare-sidecar', async () => {
    await withTempDir(async (dir) => {
      const bareStowDir = writeMobileProject(dir, { hosts: ['darwin-arm64'] })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        bareStowDir,
        network: false
      })
      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        ['unknown-runtime-version']
      )
    })
  })

  it('warns that engines.bare is unchecked when the runtime is unknown', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, { hosts: ['android-arm64'] })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64'],
        bareStowDir: writeBareStow(dir, { kotlin: '9.0.0' }),
        network: false
      })
      assert.equal(hasErrors(result), false)
      assert.equal(result.runtimes[0]?.resolution.resolved, false)
      const warning = result.issues.find((issue) => issue.code === 'unknown-runtime-version')
      assert.ok(warning)
      assert.match(warning.message, /network lookups are disabled/)
    })
  })
})
