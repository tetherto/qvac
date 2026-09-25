import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLimiter } from '@/commands/verify/addon-source'
import {
  findReactNativeBareKitUpgrade,
  parseBareKitReleaseVersion,
  parseBareVersion,
  parseInfoPlistVersion,
  resolveMobileBareRuntime
} from '@/commands/verify/bare-kit-runtime'
import {
  detectPackageManager,
  formatOverrideSnippet,
  pickOverrideVersion,
  type Packument
} from '@/commands/verify/engines-advice'
import { formatVerifyBundleResult, hasErrors, verifyBundle } from '@/commands/verify/index'

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

function infoPlist(version: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n' +
    '  <key>CFBundleShortVersionString</key>\n' +
    `  <string>${version}</string>\n</dict></plist>\n`
  )
}

const INFO_PLIST_PATH = path.join(
  'ios',
  'BareKit.xcframework',
  'ios-arm64',
  'BareKit.framework',
  'Info.plist'
)

function failingFetch(): (url: string) => Promise<string> {
  return () => Promise.reject(new Error('unexpected network request'))
}

const BARE_TYPE_PACKUMENT: Packument = {
  versions: {
    '1.0.8': { engines: { bare: '>=1.2.0' } },
    '1.1.0': { engines: { bare: '>=1.2.0' } },
    '1.1.1': { engines: { bare: '>=1.2.0' } },
    '1.2.0': { engines: { bare: '>=1.32.0' } },
    '1.4.0': { engines: { bare: '>=1.32.0' } },
    '2.0.0-rc.1': {}
  }
}

/**
 * A mobile app whose react-native-bare-kit embeds Bare 1.29.4 while the tree
 * pulls in bare-type 1.4.0 (engines.bare >=1.32.0) through bare-inspect.
 */
function writeMobileProject(
  projectRoot: string,
  options: { reactNativeBareKit?: string; hosts: string[] }
): void {
  writePackage(projectRoot, '.', { name: 'app', version: '1.0.0' })
  writeFile(path.join(projectRoot, 'package-lock.json'), '{}')
  writePackage(projectRoot, 'node_modules/react-native-bare-kit', {
    name: 'react-native-bare-kit',
    version: options.reactNativeBareKit ?? '0.14.5'
  })
  writePackage(projectRoot, 'node_modules/bare-runtime', {
    name: 'bare-runtime',
    version: '1.33.4'
  })
  writePackage(projectRoot, 'node_modules/bare-inspect', {
    name: 'bare-inspect',
    version: '3.1.10',
    dependencies: { 'bare-type': '^1.0.0' }
  })
  const bareType = writePackage(projectRoot, 'node_modules/bare-type', {
    name: 'bare-type',
    version: '1.4.0',
    addon: true,
    engines: { bare: '>=1.32.0' }
  })
  writePrebuilds(bareType, options.hosts)
}

describe('bare-kit CMakeLists and Info.plist parsing', () => {
  it('reads the bare-kit release react-native-bare-kit downloads', () => {
    const cmake =
      'fetch_package("https://github.com/holepunchto/bare-kit/releases/download/v2.2.1/prebuilds.zip" SOURCE_DIR bare-kit)'
    assert.equal(parseBareKitReleaseVersion(cmake), '2.2.1')
  })

  it('reads the Bare version bare-kit fetches', () => {
    assert.equal(
      parseBareVersion('fetch_package("github:holepunchto/bare@1.31.2" SOURCE_DIR bare)'),
      '1.31.2'
    )
    assert.equal(parseBareVersion('fetch_package("github:holepunchto/bare@1.29.4")'), '1.29.4')
  })

  it('returns null when CMakeLists.txt names no version', () => {
    assert.equal(parseBareKitReleaseVersion('project(react-native-bare-kit)'), null)
    assert.equal(parseBareVersion('project(bare_kit)'), null)
  })

  it('reads CFBundleShortVersionString from Info.plist', () => {
    assert.equal(parseInfoPlistVersion(infoPlist('2.2.1')), '2.2.1')
  })
})

describe('resolveMobileBareRuntime', () => {
  it('uses the built-in table without a network request', async () => {
    await withTempDir(async (dir) => {
      writePackage(dir, 'node_modules/react-native-bare-kit', {
        name: 'react-native-bare-kit',
        version: '0.14.5'
      })
      const progress: string[] = []
      const resolution = await resolveMobileBareRuntime({
        projectRoot: dir,
        fetchText: failingFetch(),
        onProgress: (message) => progress.push(message)
      })
      assert.ok(resolution.resolved)
      assert.equal(resolution.runtime.version, '1.29.4')
      assert.equal(resolution.runtime.source, 'react-native-bare-kit')
      assert.equal(resolution.runtime.packageVersion, '0.14.5')
      assert.deepEqual(progress, [])
    })
  })

  it('reads the bare-kit version from the iOS Info.plist when the release is not in the table', async () => {
    await withTempDir(async (dir) => {
      const pkg = writePackage(dir, 'node_modules/react-native-bare-kit', {
        name: 'react-native-bare-kit',
        version: '0.12.3'
      })
      writeFile(path.join(pkg, INFO_PLIST_PATH), infoPlist('1.15.2'))
      const resolution = await resolveMobileBareRuntime({
        projectRoot: dir,
        fetchText: failingFetch()
      })
      assert.ok(resolution.resolved)
      assert.equal(resolution.runtime.version, '1.27.0')
      assert.match(resolution.runtime.detail ?? '', /bare-kit 1\.15\.2/)
    })
  })

  it('looks up a release newer than the table on GitHub and reports it first', async () => {
    await withTempDir(async (dir) => {
      writePackage(dir, 'node_modules/react-native-bare-kit', {
        name: 'react-native-bare-kit',
        version: '9.0.0'
      })
      const requested: string[] = []
      const progress: string[] = []
      const resolution = await resolveMobileBareRuntime({
        projectRoot: dir,
        onProgress: (message) => progress.push(message),
        fetchText: (url) => {
          requested.push(url)
          if (url.includes('/react-native-bare-kit/v9.0.0/')) {
            return Promise.resolve(
              'fetch_package("https://github.com/holepunchto/bare-kit/releases/download/v9.1.0/prebuilds.zip")'
            )
          }
          if (url.includes('/bare-kit/v9.1.0/')) {
            return Promise.resolve('fetch_package("github:holepunchto/bare@1.40.0")')
          }
          return Promise.reject(new Error(`unexpected ${url}`))
        }
      })
      assert.ok(resolution.resolved)
      assert.equal(resolution.runtime.version, '1.40.0')
      assert.equal(requested.length, 2)
      assert.equal(progress.length, 1)
      assert.match(progress[0]!, /react-native-bare-kit@9\.0\.0/)
    })
  })

  it('does not query GitHub for a release older than the newest table entry', async () => {
    await withTempDir(async (dir) => {
      writePackage(dir, 'node_modules/react-native-bare-kit', {
        name: 'react-native-bare-kit',
        version: '0.11.5'
      })
      const resolution = await resolveMobileBareRuntime({
        projectRoot: dir,
        fetchText: failingFetch()
      })
      assert.equal(resolution.resolved, false)
    })
  })

  it('stays offline when network is disabled', async () => {
    await withTempDir(async (dir) => {
      writePackage(dir, 'node_modules/react-native-bare-kit', {
        name: 'react-native-bare-kit',
        version: '9.0.0'
      })
      const resolution = await resolveMobileBareRuntime({
        projectRoot: dir,
        network: false,
        fetchText: failingFetch()
      })
      assert.equal(resolution.resolved, false)
      if (!resolution.resolved) {
        assert.match(resolution.error.reason, /network lookups are disabled/)
      }
    })
  })

  it('reports react-native-bare-kit as missing', async () => {
    await withTempDir(async (dir) => {
      const resolution = await resolveMobileBareRuntime({ projectRoot: dir })
      assert.equal(resolution.resolved, false)
    })
  })
})

describe('findReactNativeBareKitUpgrade', () => {
  it('returns the oldest newer release whose Bare satisfies every range', () => {
    assert.deepEqual(findReactNativeBareKitUpgrade('0.14.5', ['>=1.32.0']), {
      version: '0.15.1',
      bareKit: '2.5.0',
      bare: '1.33.1'
    })
  })

  it('returns null when no known release is new enough', () => {
    assert.equal(findReactNativeBareKitUpgrade('0.14.5', ['>=99.0.0']), null)
  })
})

describe('pickOverrideVersion', () => {
  it('picks the newest release that runs on the runtime and satisfies every parent', () => {
    assert.equal(pickOverrideVersion(BARE_TYPE_PACKUMENT, '1.29.4', ['1.4.0'], ['^1.0.0']), '1.1.1')
  })

  it('falls back to the installed major when a parent range cannot be met', () => {
    assert.equal(
      pickOverrideVersion(BARE_TYPE_PACKUMENT, '1.29.4', ['1.4.0'], ['^1.0.0', '^1.3.0']),
      '1.1.1'
    )
  })

  it('returns null when no release runs on the runtime', () => {
    assert.equal(pickOverrideVersion(BARE_TYPE_PACKUMENT, '1.1.0', ['1.4.0'], []), null)
  })

  it('returns null when no compatible release is accepted by any parent', () => {
    const packument: Packument = {
      versions: {
        '0.0.0': {},
        '0.19.0': { engines: { bare: '^1.28.0' } },
        '0.20.0': { engines: { bare: '^1.30.3' } }
      }
    }
    assert.equal(pickOverrideVersion(packument, '1.29.4', ['0.20.0'], ['^0.20.0']), null)
  })

  it('stays on the installed release line when no parent is known', () => {
    assert.equal(pickOverrideVersion(BARE_TYPE_PACKUMENT, '1.29.4', ['1.4.0'], []), '1.1.1')
    const packument: Packument = {
      versions: { '0.19.0': {}, '0.20.0': { engines: { bare: '^1.30.3' } } }
    }
    assert.equal(pickOverrideVersion(packument, '1.29.4', ['0.20.0'], []), null)
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

describe('detectPackageManager', () => {
  it('prefers the packageManager field over lockfiles', async () => {
    await withTempDir(async (dir) => {
      writePackage(dir, '.', { name: 'app', packageManager: 'pnpm@10.0.0' })
      writeFile(path.join(dir, 'package-lock.json'), '{}')
      assert.equal(await detectPackageManager(dir), 'pnpm')
    })
  })

  it('finds a lockfile at a workspace root above the project', async () => {
    await withTempDir(async (dir) => {
      writeFile(path.join(dir, 'yarn.lock'), '')
      const app = writePackage(dir, 'apps/mobile', { name: 'mobile' })
      assert.equal(await detectPackageManager(app), 'yarn')
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

describe('verifyBundle engines.bare against the mobile runtime', () => {
  it('checks mobile hosts against react-native-bare-kit, not bare-runtime', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, { hosts: ['android-arm64', 'darwin-arm64'] })
      const progress: string[] = []
      const fetched: string[] = []
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64', 'darwin-arm64'],
        onProgress: (message) => progress.push(message),
        fetchText: failingFetch(),
        fetchPackument: (name) => {
          fetched.push(name)
          return Promise.resolve(BARE_TYPE_PACKUMENT)
        }
      })

      assert.ok(hasErrors(result))
      const mismatches = result.issues.filter((issue) => issue.code === 'abi-mismatch')
      assert.equal(mismatches.length, 1)
      assert.match(mismatches[0]!.message, /runtime is 1\.29\.4 \(from react-native-bare-kit/)

      assert.deepEqual(
        result.runtimes?.map((group) => [
          group.hosts,
          group.resolution.resolved ? group.resolution.runtime.version : null
        ]),
        [
          [['android-arm64'], '1.29.4'],
          [['darwin-arm64'], '1.33.4']
        ]
      )

      assert.deepEqual(fetched, ['bare-type'])
      assert.equal(result.advice?.length, 1)
      const advice = result.advice![0]!
      assert.deepEqual(advice.hosts, ['android-arm64'])
      assert.equal(advice.requiredBare, '1.32.0')
      assert.equal(advice.upgrade?.to, '0.15.1')
      assert.equal(advice.packageManager, 'npm')
      assert.equal(advice.overrides[0]?.version, '1.1.1')
      assert.deepEqual(advice.overrides[0]?.parents, [
        { name: 'bare-inspect', range: '^1.0.0', satisfied: true }
      ])

      assert.ok(progress.some((message) => message.startsWith('Scanning ')))
      assert.ok(progress.some((message) => message.startsWith('Looking up releases of bare-type')))

      const text = formatVerifyBundleResult(result)
      assert.match(text, /Requires: bare-type@1\.4\.0 needs Bare >=1\.32\.0/)
      assert.match(text, /Upgrade react-native-bare-kit to 0\.15\.1 or newer/)
      assert.match(text, /Option 2 \(bare-type\): pin 1\.4\.0 -> 1\.1\.1/)
      assert.match(text, /"overrides": \{ "bare-type": "1\.1\.1" \}/)
    })
  })

  it('scopes the override when another dependent needs the current version', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, { hosts: ['android-arm64'] })
      writePackage(dir, 'node_modules/bare-structured-clone', {
        name: 'bare-structured-clone',
        version: '2.0.1',
        dependencies: { 'bare-type': '^1.3.0' }
      })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64'],
        fetchText: failingFetch(),
        fetchPackument: () => Promise.resolve(BARE_TYPE_PACKUMENT)
      })
      const override = result.advice?.[0]?.overrides[0]
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

  it('passes once react-native-bare-kit embeds a new enough Bare', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, { reactNativeBareKit: '0.15.1', hosts: ['android-arm64'] })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64'],
        fetchText: failingFetch(),
        fetchPackument: () => Promise.reject(new Error('unexpected registry request'))
      })
      assert.equal(hasErrors(result), false)
      assert.equal(result.advice, undefined)
    })
  })

  it('reports non-addon packages that declare engines.bare', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, { reactNativeBareKit: '0.15.1', hosts: ['android-arm64'] })
      writePackage(dir, 'node_modules/bare-new-api', {
        name: 'bare-new-api',
        version: '2.0.0',
        engines: { bare: '>=1.40.0' }
      })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64'],
        network: false
      })
      const mismatch = result.issues.find((issue) => issue.code === 'engines-mismatch')
      assert.ok(mismatch)
      assert.match(mismatch.message, /bare-new-api@2\.0\.0 requires bare >=1\.40\.0/)
      assert.equal(result.advice?.[0]?.upgrade, null)
      assert.equal(result.advice?.[0]?.overrides[0]?.lookupSkipped, true)
      assert.match(formatVerifyBundleResult(result), /without --offline/)
    })
  })

  it('makes no network request when network is disabled', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, { hosts: ['android-arm64'] })
      const progress: string[] = []
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64'],
        network: false,
        onProgress: (message) => progress.push(message),
        fetchText: failingFetch(),
        fetchPackument: () => Promise.reject(new Error('unexpected registry request'))
      })
      assert.ok(hasErrors(result))
      assert.equal(result.advice?.[0]?.overrides[0]?.version, null)
      assert.equal(result.advice?.[0]?.upgrade?.to, '0.15.1')
      assert.ok(progress.every((message) => !message.startsWith('Looking up releases of')))
    })
  })

  it('checks mobile hosts against bare-runtime when react-native-bare-kit is not installed', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, { hosts: ['android-arm64'] })
      fs.rmSync(path.join(dir, 'node_modules', 'react-native-bare-kit'), { recursive: true })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['android-arm64'],
        network: false
      })
      assert.equal(hasErrors(result), false)
      assert.equal(result.runtime?.resolved ? result.runtime.runtime.source : null, 'bare-runtime')
    })
  })
})
