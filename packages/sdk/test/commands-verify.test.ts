import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deduplicateAddons,
  formatAddonId,
  readAddonPackageJson
} from '@/commands/verify/addon-source'
import { collectAddonsFromBundle, InvalidBundleSourceError } from '@/commands/verify/bundle-source'
import {
  collectAddonsFromNodeModules,
  InvalidNodeModulesSourceError
} from '@/commands/verify/node-modules-source'
import { checkPrebuilds, resolvePrebuildLocations } from '@/commands/verify/prebuilds'
import { checkAbi, resolveBareRuntime, type BareRuntimeResolution } from '@/commands/verify/abi'
import {
  formatVerifyBundleResult,
  hasErrors,
  hasWarnings,
  verifyBundle
} from '@/commands/verify/index'

async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-verify-bundle-')))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function writePackageJson(
  projectRoot: string,
  relPackageDir: string,
  body: Record<string, unknown>
): string {
  const packageJsonPath = path.join(projectRoot, relPackageDir, 'package.json')
  writeJson(packageJsonPath, body)
  return path.join(projectRoot, relPackageDir)
}

function writePrebuild(packageRoot: string, host: string, filename = 'native.bare'): void {
  const dir = path.join(packageRoot, 'prebuilds', host)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), '')
}

const BUNDLE_MAIN = '/app/entry.js'

const BARE_POSIX_PKG = '/node_modules/bare-posix/package.json'
const BARE_OS_PKG = '/node_modules/bare-os/package.json'

/** An unrelated addon, linked on every host. */
function linkedNeighbour(): Record<string, unknown> {
  return {
    '/node_modules/bare-os/index.js': { '#package': BARE_OS_PKG, '.': 'linked:bare-os-3.9.3' },
    [BARE_OS_PKG]: {}
  }
}

/** `bare-posix` as bare-pack emits it for several hosts: every branch kept. */
function multiHostResolutions(): Record<string, unknown> {
  return {
    [BUNDLE_MAIN]: {
      'bare-process': '/node_modules/bare-process/index.js',
      'bare-os': '/node_modules/bare-os/index.js'
    },
    '/node_modules/bare-process/index.js': {
      '#package': '/node_modules/bare-process/package.json',
      'bare-posix': {
        win32: '/node_modules/bare-posix/unsupported.js',
        android: '/node_modules/bare-posix/unsupported.js',
        default: '/node_modules/bare-posix/index.js'
      }
    },
    '/node_modules/bare-posix/index.js': {
      '#package': BARE_POSIX_PKG,
      './binding': '/node_modules/bare-posix/binding.js'
    },
    '/node_modules/bare-posix/binding.js': {
      '#package': BARE_POSIX_PKG,
      '.': {
        darwin: 'linked:bare-posix.1.0.1.framework/bare-posix.1.0.1',
        linux: 'linked:libbare-posix.1.0.1.so',
        win32: 'linked:bare-posix-1.0.1.dll',
        android: 'linked:libbare-posix.1.0.1.so',
        ios: 'linked:bare-posix.1.0.1.framework/bare-posix.1.0.1'
      }
    },
    '/node_modules/bare-posix/unsupported.js': { '#package': BARE_POSIX_PKG },
    [BARE_POSIX_PKG]: {},
    ...linkedNeighbour()
  }
}

/** `bare-posix` as bare-pack emits it for one host: conditions resolved eagerly. */
function singleHostResolutions(options: { linked: boolean }): Record<string, unknown> {
  const reached = options.linked
    ? {
        '/node_modules/bare-posix/index.js': {
          '#package': BARE_POSIX_PKG,
          './binding': '/node_modules/bare-posix/binding.js'
        },
        '/node_modules/bare-posix/binding.js': {
          '#package': BARE_POSIX_PKG,
          '.': 'linked:libbare-posix.1.0.1.so'
        }
      }
    : { '/node_modules/bare-posix/unsupported.js': { '#package': BARE_POSIX_PKG } }

  return {
    [BUNDLE_MAIN]: {
      'bare-process': '/node_modules/bare-process/index.js',
      'bare-os': '/node_modules/bare-os/index.js'
    },
    '/node_modules/bare-process/index.js': {
      '#package': '/node_modules/bare-process/package.json',
      'bare-posix': options.linked
        ? '/node_modules/bare-posix/index.js'
        : '/node_modules/bare-posix/unsupported.js'
    },
    ...reached,
    [BARE_POSIX_PKG]: {},
    ...linkedNeighbour()
  }
}

/** The addon packages the graph fixtures refer to. */
function writeGraphPackages(projectRoot: string, options: { hosts?: string[] } = {}): void {
  writePackageJson(projectRoot, 'node_modules/bare-posix', {
    name: 'bare-posix',
    version: '1.0.1',
    addon: true
  })
  const bareOs = writePackageJson(projectRoot, 'node_modules/bare-os', {
    name: 'bare-os',
    version: '3.9.3',
    addon: true
  })
  for (const host of options.hosts ?? []) writePrebuild(bareOs, host)
}

function escapeForJsString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

function writeBareBundle(
  bundlePath: string,
  resolutions: Record<string, unknown>,
  options: { id?: string; body?: string; main?: string; imports?: Record<string, unknown> } = {}
): void {
  const bundleId = options.id ?? 'test-bundle-id'
  const header = JSON.stringify({
    id: bundleId,
    ...(options.main === undefined ? {} : { main: options.main }),
    ...(options.imports === undefined ? {} : { imports: options.imports }),
    resolutions
  })
  const packed = `${bundleId}\n${header}\n${options.body ?? ''}`
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true })
  fs.writeFileSync(bundlePath, `module.exports = "${escapeForJsString(packed)}"`)
}

describe('readAddonPackageJson', () => {
  it('returns not-found when the package.json does not exist', async () => {
    await withTempDir(async (dir) => {
      const result = await readAddonPackageJson({
        packageJsonPath: path.join(dir, 'nope', 'package.json')
      })
      assert.equal(result.found, false)
      assert.equal(result.isAddon, false)
    })
  })

  it('returns found-but-not-addon for non-addon package.json', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'package.json'), { name: 'foo', version: '1.0.0' })
      const result = await readAddonPackageJson({
        packageJsonPath: path.join(dir, 'package.json')
      })
      assert.equal(result.found, true)
      assert.equal(result.isAddon, false)
    })
  })

  it('extracts name, version, engines.bare for an addon package.json', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'package.json'), {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      const result = await readAddonPackageJson({
        packageJsonPath: path.join(dir, 'package.json')
      })
      assert.equal(result.isAddon, true)
      assert.deepEqual(result.addon, {
        name: 'bare-os',
        version: '3.9.0',
        packageJsonPath: path.join(dir, 'package.json'),
        packageRoot: dir,
        enginesBare: '>=1.14.0'
      })
    })
  })

  it('falls back to expectedName when package.json has no name', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'package.json'), { addon: true, version: '1.0.0' })
      const result = await readAddonPackageJson({
        packageJsonPath: path.join(dir, 'package.json'),
        expectedName: 'bare-fallback'
      })
      assert.equal(result.isAddon, true)
      assert.equal(result.addon?.name, 'bare-fallback')
    })
  })

  it('returns not-addon for malformed JSON and surfaces an invalid record for diagnostics', async () => {
    await withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'package.json'), '{not json')
      const result = await readAddonPackageJson({
        packageJsonPath: path.join(dir, 'package.json'),
        expectedName: 'broken-addon'
      })
      assert.equal(result.found, true)
      assert.equal(result.isAddon, false)
      assert.ok(result.invalid, 'expected invalid record for malformed package.json')
      assert.match(result.invalid?.reason ?? '', /malformed JSON/)
      assert.equal(result.invalid?.expectedName, 'broken-addon')
    })
  })
})

describe('deduplicateAddons', () => {
  it('deduplicates by name@version + packageRoot', () => {
    const a = {
      name: 'bare-os',
      version: '3.9.0',
      packageJsonPath: '/x/package.json',
      packageRoot: '/x'
    }
    const b = { ...a }
    const c = { ...a, packageRoot: '/y', packageJsonPath: '/y/package.json' }
    const d = { ...a, version: '4.0.0' }
    const result = deduplicateAddons([a, b, c, d])
    assert.equal(result.length, 3)
    assert.deepEqual(
      result.map((r) => formatAddonId(r) + '|' + r.packageRoot),
      ['bare-os@3.9.0|/x', 'bare-os@3.9.0|/y', 'bare-os@4.0.0|/x']
    )
  })

  it('treats unknown versions as a stable key', () => {
    const a = {
      name: 'foo',
      packageJsonPath: '/x/package.json',
      packageRoot: '/x'
    }
    const b = { ...a }
    assert.equal(deduplicateAddons([a, b]).length, 1)
  })
})

describe('collectAddonsFromBundle', () => {
  it('throws InvalidBundleSourceError when bundle is missing', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(
        () =>
          collectAddonsFromBundle({
            bundlePath: path.join(dir, 'missing.js'),
            projectRoot: dir
          }),
        InvalidBundleSourceError
      )
    })
  })

  it('throws InvalidBundleSourceError when bundle is not a bare-pack output', async () => {
    await withTempDir(async (dir) => {
      const bundlePath = path.join(dir, 'worker.bundle.js')
      fs.writeFileSync(bundlePath, 'export const foo = 1')
      await assert.rejects(
        () => collectAddonsFromBundle({ bundlePath, projectRoot: dir }),
        InvalidBundleSourceError
      )
    })
  })

  it('returns no addons when resolutions reference only non-addon packages', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/foo', { name: 'foo', version: '1.0.0' })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, {
        '/node_modules/foo/index.js': true
      })
      const addons = await collectAddonsFromBundle({ bundlePath, projectRoot: dir })
      assert.deepEqual(addons, [])
    })
  })

  it('finds a top-level addon package', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, {
        '/node_modules/bare-os/index.js': true
      })
      const addons = await collectAddonsFromBundle({ bundlePath, projectRoot: dir })
      assert.equal(addons.length, 1)
      assert.equal(addons[0]?.name, 'bare-os')
      assert.equal(addons[0]?.version, '3.9.0')
    })
  })

  it('finds a nested addon package via the path index', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/parent', { name: 'parent', version: '1.0.0' })
      writePackageJson(dir, 'node_modules/parent/node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, {
        '/node_modules/parent/node_modules/bare-os/index.js': true
      })
      const addons = await collectAddonsFromBundle({ bundlePath, projectRoot: dir })
      assert.equal(addons.length, 1)
      assert.equal(addons[0]?.name, 'bare-os')
      assert.equal(addons[0]?.packageRoot.endsWith('parent/node_modules/bare-os'), true)
    })
  })

  it('captures engines.bare on bundle addons', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, { '/node_modules/bare-os/index.js': true })
      const addons = await collectAddonsFromBundle({ bundlePath, projectRoot: dir })
      assert.equal(addons[0]?.enginesBare, '>=1.14.0')
    })
  })

  it('uses the bundle-referenced nested path even when a top-level same-name package exists', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '2.0.0',
        addon: false
      })
      writePackageJson(dir, 'node_modules/parent', { name: 'parent', version: '1.0.0' })
      writePackageJson(dir, 'node_modules/parent/node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, {
        '/node_modules/parent/node_modules/bare-os/index.js': true
      })
      const addons = await collectAddonsFromBundle({ bundlePath, projectRoot: dir })
      assert.equal(addons.length, 1)
      assert.equal(addons[0]?.name, 'bare-os')
      assert.equal(addons[0]?.version, '3.9.0')
      assert.equal(
        addons[0]?.packageRoot.endsWith(path.join('parent', 'node_modules', 'bare-os')),
        true
      )
    })
  })

  it('keeps separate entries when the bundle references both top-level and nested instances at different versions', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      writePackageJson(dir, 'node_modules/parent', { name: 'parent', version: '1.0.0' })
      writePackageJson(dir, 'node_modules/parent/node_modules/bare-os', {
        name: 'bare-os',
        version: '4.0.0',
        addon: true
      })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, {
        '/node_modules/bare-os/index.js': true,
        '/node_modules/parent/node_modules/bare-os/index.js': true
      })
      const addons = await collectAddonsFromBundle({ bundlePath, projectRoot: dir })
      assert.equal(addons.length, 2)
      assert.deepEqual(addons.map((a) => a.version).sort(), ['3.9.0', '4.0.0'])
    })
  })

  it('finds a deeply-nested addon whose package name repeats earlier in the resolution key', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/foo', {
        name: 'foo',
        version: '1.0.0',
        addon: false
      })
      writePackageJson(dir, 'node_modules/foo/node_modules/bar', {
        name: 'bar',
        version: '1.0.0'
      })
      writePackageJson(dir, 'node_modules/foo/node_modules/bar/node_modules/foo', {
        name: 'foo',
        version: '2.0.0',
        addon: true
      })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, {
        '/node_modules/foo/node_modules/bar/node_modules/foo/index.js': true
      })
      const addons = await collectAddonsFromBundle({ bundlePath, projectRoot: dir })
      const fooAddons = addons.filter((a) => a.name === 'foo')
      assert.equal(fooAddons.length, 1)
      assert.equal(fooAddons[0]?.version, '2.0.0')
      assert.equal(
        fooAddons[0]?.packageRoot.endsWith(
          path.join('foo', 'node_modules', 'bar', 'node_modules', 'foo')
        ),
        true
      )
    })
  })

  it('reports only the hosts whose conditional resolution reaches the addon', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, multiHostResolutions(), { main: BUNDLE_MAIN })
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['darwin-arm64', 'linux-x64', 'win32-x64', 'android-arm64', 'ios-arm64']
      })
      const barePosix = addons.find((a) => a.name === 'bare-posix')
      assert.deepEqual(barePosix?.linkedHosts, ['darwin-arm64', 'ios-arm64', 'linux-x64'])
    })
  })

  it('uses `default` only when no platform branch matched', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, multiHostResolutions(), { main: BUNDLE_MAIN })
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['win32-x64', 'linux-x64']
      })
      assert.deepEqual(addons.find((a) => a.name === 'bare-posix')?.linkedHosts, ['linux-x64'])
    })
  })

  it('reports no linked host for an addon a single-host graph resolved away', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, singleHostResolutions({ linked: false }), { main: BUNDLE_MAIN })
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['win32-x64']
      })
      assert.deepEqual(addons.find((a) => a.name === 'bare-posix')?.linkedHosts, [])
      assert.deepEqual(addons.find((a) => a.name === 'bare-os')?.linkedHosts, ['win32-x64'])
    })
  })

  it('reports the host for an addon a single-host graph did link', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, singleHostResolutions({ linked: true }), { main: BUNDLE_MAIN })
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['linux-x64']
      })
      assert.deepEqual(addons.find((a) => a.name === 'bare-posix')?.linkedHosts, ['linux-x64'])
    })
  })

  it('abstains when no hosts are supplied', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, multiHostResolutions(), { main: BUNDLE_MAIN })
      const addons = await collectAddonsFromBundle({ bundlePath, projectRoot: dir })
      assert.ok(addons.every((a) => a.linkedHosts === undefined))
    })
  })

  it('abstains when the header carries no main', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, multiHostResolutions())
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['win32-x64']
      })
      assert.ok(addons.every((a) => a.linkedHosts === undefined))
    })
  })

  it('abstains when main is absent from the graph', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, multiHostResolutions(), { main: '/app/missing.js' })
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['win32-x64']
      })
      assert.ok(addons.every((a) => a.linkedHosts === undefined))
    })
  })

  it('abstains when the graph links no addon at all', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(
        bundlePath,
        {
          [BUNDLE_MAIN]: { 'bare-posix': '/node_modules/bare-posix/index.js' },
          '/node_modules/bare-posix/index.js': { '#package': BARE_POSIX_PKG },
          [BARE_POSIX_PKG]: {}
        },
        { main: BUNDLE_MAIN }
      )
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['win32-x64']
      })
      assert.ok(addons.every((a) => a.linkedHosts === undefined))
    })
  })

  it('abstains when the requested hosts are not the ones the bundle links', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(
        bundlePath,
        {
          [BUNDLE_MAIN]: { 'bare-os': '/node_modules/bare-os/index.js' },
          '/node_modules/bare-os/index.js': {
            '#package': BARE_OS_PKG,
            '.': { android: 'linked:libbare-os.so', ios: 'linked:bare-os.framework' }
          },
          [BARE_OS_PKG]: {}
        },
        { main: BUNDLE_MAIN }
      )
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['win32-x64']
      })
      assert.ok(addons.every((a) => a.linkedHosts === undefined))
    })
  })

  it('abstains when a linked module cannot be attributed to a package', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(
        bundlePath,
        {
          [BUNDLE_MAIN]: { 'bare-os': '/node_modules/bare-os/index.js' },
          '/node_modules/bare-os/index.js': { '.': 'linked:bare-os-3.9.3' },
          [BARE_OS_PKG]: {}
        },
        { main: BUNDLE_MAIN }
      )
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['win32-x64']
      })
      assert.ok(addons.every((a) => a.linkedHosts === undefined))
    })
  })

  it('abstains when the header carries an import map it cannot walk', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, multiHostResolutions(), {
        main: BUNDLE_MAIN,
        imports: { '#rpc': '/node_modules/somewhere/rpc.js' }
      })
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['win32-x64', 'linux-x64']
      })
      assert.ok(addons.every((a) => a.linkedHosts === undefined))
    })
  })

  it('abstains when owner paths do not line up with the enumerated packages', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(
        bundlePath,
        {
          [BUNDLE_MAIN]: { 'bare-os': '/node_modules/bare-os/index.js' },
          '/node_modules/bare-os/index.js': {
            '#package': '/vendored/bare-os/package.json',
            '.': 'linked:bare-os-3.9.3'
          },
          [BARE_OS_PKG]: {}
        },
        { main: BUNDLE_MAIN }
      )
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['win32-x64']
      })
      assert.ok(addons.length > 0, 'expected the path index to still enumerate the package')
      assert.ok(addons.every((a) => a.linkedHosts === undefined))
    })
  })

  it('keeps a host linked when an undecidable condition guards the addon', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir)
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(
        bundlePath,
        {
          [BUNDLE_MAIN]: { 'bare-os': '/node_modules/bare-os/index.js' },
          '/node_modules/bare-os/index.js': {
            '#package': BARE_OS_PKG,
            './binding': { require: '/node_modules/bare-os/binding.js' }
          },
          '/node_modules/bare-os/binding.js': {
            '#package': BARE_OS_PKG,
            '.': 'linked:bare-os-3.9.3'
          },
          [BARE_OS_PKG]: {}
        },
        { main: BUNDLE_MAIN }
      )
      const addons = await collectAddonsFromBundle({
        bundlePath,
        projectRoot: dir,
        hosts: ['win32-x64']
      })
      assert.deepEqual(addons.find((a) => a.name === 'bare-os')?.linkedHosts, ['win32-x64'])
    })
  })
})

describe('collectAddonsFromNodeModules', () => {
  it('throws InvalidNodeModulesSourceError when the root is missing', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(
        () =>
          collectAddonsFromNodeModules({
            nodeModulesRoot: path.join(dir, 'nope')
          }),
        InvalidNodeModulesSourceError
      )
    })
  })

  it('returns an empty list for an empty node_modules', async () => {
    await withTempDir(async (dir) => {
      const nm = path.join(dir, 'node_modules')
      fs.mkdirSync(nm)
      const result = await collectAddonsFromNodeModules({ nodeModulesRoot: nm })
      assert.deepEqual(result, [])
    })
  })

  it('finds top-level, scoped, and nested addons', async () => {
    await withTempDir(async (dir) => {
      const nm = path.join(dir, 'node_modules')
      writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      writePackageJson(dir, 'node_modules/@qvac/native-thing', {
        name: '@qvac/native-thing',
        version: '0.1.0',
        addon: true
      })
      writePackageJson(dir, 'node_modules/parent', { name: 'parent', version: '1.0.0' })
      writePackageJson(dir, 'node_modules/parent/node_modules/bare-crypto', {
        name: 'bare-crypto',
        version: '2.0.0',
        addon: true
      })
      writePackageJson(dir, 'node_modules/normal', {
        name: 'normal',
        version: '1.0.0'
      })

      const result = await collectAddonsFromNodeModules({ nodeModulesRoot: nm })
      const names = result.map((r) => r.name).sort()
      assert.deepEqual(names, ['@qvac/native-thing', 'bare-crypto', 'bare-os'])
    })
  })

  it('ignores hidden directories', async () => {
    await withTempDir(async (dir) => {
      const nm = path.join(dir, 'node_modules')
      writePackageJson(dir, 'node_modules/.cache', { addon: true, name: 'hidden' })
      writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        addon: true,
        version: '1.0.0'
      })
      const result = await collectAddonsFromNodeModules({ nodeModulesRoot: nm })
      assert.deepEqual(
        result.map((r) => r.name),
        ['bare-os']
      )
    })
  })

  it('walks symlinked package directories (pnpm / yarn-pnp layouts)', async () => {
    await withTempDir(async (dir) => {
      const nm = path.join(dir, 'node_modules')
      const store = path.join(dir, '.store')
      writePackageJson(store, 'bare-os-real', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      writePackageJson(store, 'qvac-native-real', {
        name: '@qvac/native-thing',
        version: '0.1.0',
        addon: true
      })
      fs.mkdirSync(nm, { recursive: true })
      fs.symlinkSync(path.join(store, 'bare-os-real'), path.join(nm, 'bare-os'), 'dir')
      fs.mkdirSync(path.join(nm, '@qvac'), { recursive: true })
      fs.symlinkSync(
        path.join(store, 'qvac-native-real'),
        path.join(nm, '@qvac', 'native-thing'),
        'dir'
      )
      const result = await collectAddonsFromNodeModules({ nodeModulesRoot: nm })
      const names = result.map((r) => r.name).sort()
      assert.deepEqual(names, ['@qvac/native-thing', 'bare-os'])
    })
  })
})

describe('checkPrebuilds', () => {
  it('reports missing-prebuild when the host directory is missing', async () => {
    await withTempDir(async (dir) => {
      const issues = await checkPrebuilds({
        addon: {
          name: 'bare-os',
          version: '3.9.0',
          packageRoot: dir,
          packageJsonPath: path.join(dir, 'package.json')
        },
        hosts: ['ios-arm64-simulator']
      })
      assert.equal(issues.length, 1)
      assert.equal(issues[0]?.code, 'missing-prebuild')
      assert.equal(issues[0]?.host, 'ios-arm64-simulator')
    })
  })

  it('reports missing-prebuild when the host directory has no .bare files', async () => {
    await withTempDir(async (dir) => {
      fs.mkdirSync(path.join(dir, 'prebuilds', 'ios-arm64'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'prebuilds', 'ios-arm64', 'readme.txt'), '')
      const issues = await checkPrebuilds({
        addon: {
          name: 'bare-os',
          version: '3.9.0',
          packageRoot: dir,
          packageJsonPath: path.join(dir, 'package.json')
        },
        hosts: ['ios-arm64']
      })
      assert.equal(issues.length, 1)
    })
  })

  it('passes when a .bare file exists for every host', async () => {
    await withTempDir(async (dir) => {
      writePrebuild(dir, 'ios-arm64')
      writePrebuild(dir, 'android-arm64')
      const issues = await checkPrebuilds({
        addon: {
          name: 'bare-os',
          version: '3.9.0',
          packageRoot: dir,
          packageJsonPath: path.join(dir, 'package.json')
        },
        hosts: ['ios-arm64', 'android-arm64']
      })
      assert.deepEqual(issues, [])
    })
  })

  it('reports per-host failures independently', async () => {
    await withTempDir(async (dir) => {
      writePrebuild(dir, 'ios-arm64')
      const issues = await checkPrebuilds({
        addon: {
          name: 'bare-os',
          version: '3.9.0',
          packageRoot: dir,
          packageJsonPath: path.join(dir, 'package.json')
        },
        hosts: ['ios-arm64', 'android-arm64', 'ios-arm64-simulator']
      })
      assert.deepEqual(issues.map((i) => i.host).sort(), ['android-arm64', 'ios-arm64-simulator'])
    })
  })

  it('checks only the hosts that link the addon', async () => {
    await withTempDir(async (dir) => {
      writePrebuild(dir, 'linux-x64')
      const issues = await checkPrebuilds({
        addon: {
          name: 'bare-posix',
          version: '1.0.1',
          packageRoot: dir,
          packageJsonPath: path.join(dir, 'package.json'),
          linkedHosts: ['linux-x64']
        },
        hosts: ['linux-x64', 'win32-x64', 'android-arm64']
      })
      assert.deepEqual(issues, [])
    })
  })

  it('still reports a linked host that has no prebuild', async () => {
    await withTempDir(async (dir) => {
      const issues = await checkPrebuilds({
        addon: {
          name: 'bare-posix',
          version: '1.0.1',
          packageRoot: dir,
          packageJsonPath: path.join(dir, 'package.json'),
          linkedHosts: ['linux-x64']
        },
        hosts: ['linux-x64', 'win32-x64']
      })
      assert.deepEqual(
        issues.map((i) => i.host),
        ['linux-x64']
      )
    })
  })

  it('checks nothing for an addon the bundle links nowhere', async () => {
    await withTempDir(async (dir) => {
      const issues = await checkPrebuilds({
        addon: {
          name: 'bare-posix',
          version: '1.0.1',
          packageRoot: dir,
          packageJsonPath: path.join(dir, 'package.json'),
          linkedHosts: []
        },
        hosts: ['win32-x64', 'android-arm64']
      })
      assert.deepEqual(issues, [])
    })
  })

  it('checks every host when link information is absent', async () => {
    await withTempDir(async (dir) => {
      const issues = await checkPrebuilds({
        addon: {
          name: 'bare-posix',
          version: '1.0.1',
          packageRoot: dir,
          packageJsonPath: path.join(dir, 'package.json')
        },
        hosts: ['win32-x64', 'linux-x64']
      })
      assert.deepEqual(
        issues.map((i) => i.host),
        ['win32-x64', 'linux-x64']
      )
    })
  })
})

function writePlatformPackage(
  projectRoot: string,
  relPackageDir: string,
  options: { name: string; addon: string; hosts: string[] }
): string {
  const platformRoot = writePackageJson(projectRoot, relPackageDir, {
    name: options.name,
    version: '0.9.0'
  })
  writeJson(path.join(platformRoot, 'addon', 'package.json'), {
    name: options.addon,
    version: '0.9.0',
    addon: true
  })
  for (const host of options.hosts) {
    writePrebuild(path.join(platformRoot, 'addon'), host)
  }
  return platformRoot
}

function metaAddon(packageRoot: string) {
  return {
    name: '@qvac/tts-ggml',
    version: '0.9.0',
    packageRoot,
    packageJsonPath: path.join(packageRoot, 'package.json')
  }
}

function ttsHostAddonMap() {
  return {
    linux: {
      x64: ['@qvac/tts-ggml-linux-x64', './addon-unavailable.js'],
      arm64: ['@qvac/tts-ggml-linux-arm64', './addon-unavailable.js']
    },
    darwin: {
      arm64: ['@qvac/tts-ggml-darwin-arm64', './addon-unavailable.js'],
      x64: ['@qvac/tts-ggml-darwin-x64', './addon-unavailable.js']
    },
    win32: {
      x64: ['@qvac/tts-ggml-win32-x64', './addon-unavailable.js']
    },
    android: {
      arm64: ['@qvac/tts-ggml-android-arm64', './addon-unavailable.js']
    },
    ios: ['@qvac/tts-ggml-ios', './addon-unavailable.js']
  }
}

function splitTtsManifest(): Record<string, unknown> {
  return {
    name: '@qvac/tts-ggml',
    version: '0.9.0',
    addon: true,
    imports: { '#host-addon': ttsHostAddonMap() }
  }
}

describe('checkPrebuilds with per-platform prebuild packages', () => {
  it('accepts a prebuild shipped by a platform package hoisted next to the meta package', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/@qvac/tts-ggml', splitTtsManifest())
      writePlatformPackage(dir, 'node_modules/@qvac/tts-ggml-darwin-arm64', {
        name: '@qvac/tts-ggml-darwin-arm64',
        addon: '@qvac/tts-ggml',
        hosts: ['darwin-arm64']
      })
      const issues = await checkPrebuilds({
        addon: metaAddon(packageRoot),
        hosts: ['darwin-arm64']
      })
      assert.deepEqual(issues, [])
    })
  })

  it('accepts a platform package nested under the meta package', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/@qvac/tts-ggml', splitTtsManifest())
      writePlatformPackage(
        dir,
        'node_modules/@qvac/tts-ggml/node_modules/@qvac/tts-ggml-linux-x64',
        {
          name: '@qvac/tts-ggml-linux-x64',
          addon: '@qvac/tts-ggml',
          hosts: ['linux-x64']
        }
      )
      const issues = await checkPrebuilds({ addon: metaAddon(packageRoot), hosts: ['linux-x64'] })
      assert.deepEqual(issues, [])
    })
  })

  it('finds every iOS host inside the grouped -ios platform package', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/@qvac/tts-ggml', splitTtsManifest())
      const hosts = ['ios-arm64', 'ios-arm64-simulator', 'ios-x64-simulator']
      writePlatformPackage(dir, 'node_modules/@qvac/tts-ggml-ios', {
        name: '@qvac/tts-ggml-ios',
        addon: '@qvac/tts-ggml',
        hosts
      })
      const issues = await checkPrebuilds({ addon: metaAddon(packageRoot), hosts })
      assert.deepEqual(issues, [])
    })
  })

  it('still reports missing-prebuild for hosts no installed package covers', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/@qvac/tts-ggml', splitTtsManifest())
      writePlatformPackage(dir, 'node_modules/@qvac/tts-ggml-darwin-arm64', {
        name: '@qvac/tts-ggml-darwin-arm64',
        addon: '@qvac/tts-ggml',
        hosts: ['darwin-arm64']
      })
      writePlatformPackage(dir, 'node_modules/@qvac/tts-ggml-win32-x64', {
        name: '@qvac/tts-ggml-win32-x64',
        addon: '@qvac/tts-ggml',
        hosts: []
      })
      const issues = await checkPrebuilds({
        addon: metaAddon(packageRoot),
        hosts: ['darwin-arm64', 'linux-x64', 'win32-x64']
      })
      assert.deepEqual(issues.map((i) => i.host).sort(), ['linux-x64', 'win32-x64'])

      const linux = issues.find((i) => i.host === 'linux-x64')
      assert.ok(linux)
      assert.match(linux.message, /"@qvac\/tts-ggml-linux-x64": "0\.9\.0"/)

      const win32 = issues.find((i) => i.host === 'win32-x64')
      assert.ok(win32)
      assert.match(win32.message, /tts-ggml-win32-x64[\\/]addon[\\/]prebuilds[\\/]win32-x64/)
      assert.doesNotMatch(win32.message, /"@qvac\/tts-ggml-win32-x64": "0\.9\.0"/)
    })
  })

  it('names the exact platform-package pin when a split addon slice is missing', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/@qvac/tts-ggml', splitTtsManifest())
      const issues = await checkPrebuilds({
        addon: metaAddon(packageRoot),
        hosts: ['android-arm64']
      })
      assert.equal(issues.length, 1)
      assert.match(
        issues[0]?.message ?? '',
        /Add this exact dependency to package\.json \(same version as @qvac\/tts-ggml\) and reinstall: "@qvac\/tts-ggml-android-arm64": "0\.9\.0"/
      )
    })
  })

  it('does not invent a platform package when the addon has no #host-addon map', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/@qvac/llm-llamacpp', {
        name: '@qvac/llm-llamacpp',
        version: '0.53.0',
        addon: true
      })
      writePlatformPackage(dir, 'node_modules/@qvac/llm-llamacpp-android-arm64', {
        name: '@qvac/llm-llamacpp-android-arm64',
        addon: '@qvac/llm-llamacpp',
        hosts: ['android-arm64']
      })
      const issues = await checkPrebuilds({
        addon: {
          name: '@qvac/llm-llamacpp',
          version: '0.53.0',
          packageRoot,
          packageJsonPath: path.join(packageRoot, 'package.json')
        },
        hosts: ['android-arm64']
      })
      assert.equal(issues.length, 1)
      assert.doesNotMatch(issues[0]?.message ?? '', /llm-llamacpp-android-arm64/)
    })
  })

  it('searches the meta package prebuilds first, then the platform package', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/@qvac/tts-ggml', splitTtsManifest())
      const platformRoot = writePlatformPackage(dir, 'node_modules/@qvac/tts-ggml-darwin-arm64', {
        name: '@qvac/tts-ggml-darwin-arm64',
        addon: '@qvac/tts-ggml',
        hosts: ['darwin-arm64']
      })

      const locations = await resolvePrebuildLocations(metaAddon(packageRoot), 'darwin-arm64')
      assert.deepEqual(locations, [
        { hostDir: path.join(packageRoot, 'prebuilds', 'darwin-arm64') },
        {
          hostDir: path.join(platformRoot, 'addon', 'prebuilds', 'darwin-arm64'),
          platformPackage: '@qvac/tts-ggml-darwin-arm64'
        }
      ])

      const withoutPlatform = await resolvePrebuildLocations(metaAddon(packageRoot), 'linux-x64')
      assert.deepEqual(withoutPlatform, [
        { hostDir: path.join(packageRoot, 'prebuilds', 'linux-x64') }
      ])
    })
  })

  it('follows the meta package symlink into a pnpm virtual store to find its platform package', async () => {
    await withTempDir(async (dir) => {
      // pnpm's isolated layout: the project's node_modules/@qvac/tts-ggml is a
      // symlink into node_modules/.pnpm/<id>/node_modules/@qvac/tts-ggml, and
      // the addon's own dependencies — the platform package included — are
      // linked next to it in that store directory, never at the top level.
      const storeScope = 'node_modules/.pnpm/@qvac+tts-ggml@0.9.0/node_modules/@qvac'
      const realPackageRoot = writePackageJson(dir, `${storeScope}/tts-ggml`, splitTtsManifest())
      const platformRoot = writePlatformPackage(
        dir,
        'node_modules/.pnpm/@qvac+tts-ggml-darwin-arm64@0.9.0/node_modules/@qvac/tts-ggml-darwin-arm64',
        {
          name: '@qvac/tts-ggml-darwin-arm64',
          addon: '@qvac/tts-ggml',
          hosts: ['darwin-arm64']
        }
      )
      symlinkDir(platformRoot, path.join(dir, storeScope, 'tts-ggml-darwin-arm64'))
      const linkedPackageRoot = path.join(dir, 'node_modules', '@qvac', 'tts-ggml')
      symlinkDir(realPackageRoot, linkedPackageRoot)

      // The node_modules walker hands the verifier the top-level symlink path.
      const issues = await checkPrebuilds({
        addon: metaAddon(linkedPackageRoot),
        hosts: ['darwin-arm64']
      })
      assert.deepEqual(issues, [])

      const locations = await resolvePrebuildLocations(metaAddon(linkedPackageRoot), 'darwin-arm64')
      assert.deepEqual(locations, [
        { hostDir: path.join(linkedPackageRoot, 'prebuilds', 'darwin-arm64') },
        {
          hostDir: path.join(
            realPackageRoot,
            '..',
            'tts-ggml-darwin-arm64',
            'addon',
            'prebuilds',
            'darwin-arm64'
          ),
          platformPackage: '@qvac/tts-ggml-darwin-arm64'
        }
      ])
    })
  })
})

function symlinkDir(target: string, linkPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

describe('resolveBareRuntime', () => {
  it('uses the explicit bareRuntimeVersion when provided', async () => {
    await withTempDir(async (dir) => {
      const result = await resolveBareRuntime({
        projectRoot: dir,
        explicitVersion: '1.15.2'
      })
      assert.equal(result.resolved, true)
      if (result.resolved) {
        assert.equal(result.runtime.version, '1.15.2')
        assert.equal(result.runtime.source, 'flag')
      }
    })
  })

  it('reads from bare-runtime/version when present', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'node_modules', 'bare-runtime', 'package.json'), {
        name: 'bare-runtime',
        version: '1.16.0'
      })
      const result = await resolveBareRuntime({ projectRoot: dir })
      assert.equal(result.resolved, true)
      if (result.resolved) assert.equal(result.runtime.source, 'bare-runtime')
    })
  })

  it('prefers bare-runtime over bare when both are installed', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'node_modules', 'bare-runtime', 'package.json'), {
        name: 'bare-runtime',
        version: '1.16.0'
      })
      writeJson(path.join(dir, 'node_modules', 'bare', 'package.json'), {
        name: 'bare',
        version: '1.15.0'
      })
      const result = await resolveBareRuntime({ projectRoot: dir })
      assert.equal(result.resolved, true)
      if (result.resolved) {
        assert.equal(result.runtime.version, '1.16.0')
        assert.equal(result.runtime.source, 'bare-runtime')
      }
    })
  })

  it('falls back to bare/version when bare-runtime is not installed', async () => {
    await withTempDir(async (dir) => {
      writeJson(path.join(dir, 'node_modules', 'bare', 'package.json'), {
        name: 'bare',
        version: '1.15.0'
      })
      const result = await resolveBareRuntime({ projectRoot: dir })
      assert.equal(result.resolved, true)
      if (result.resolved) {
        assert.equal(result.runtime.version, '1.15.0')
        assert.equal(result.runtime.source, 'bare')
      }
    })
  })

  it('returns an unresolved result with tried paths when nothing is installed', async () => {
    await withTempDir(async (dir) => {
      const result = await resolveBareRuntime({ projectRoot: dir })
      assert.equal(result.resolved, false)
      if (!result.resolved) {
        assert.ok(result.error.triedPaths.length >= 2)
      }
    })
  })

  it('preserves pre-release tags so RC runtimes are not silently coerced to a release', async () => {
    await withTempDir(async (dir) => {
      const result = await resolveBareRuntime({
        projectRoot: dir,
        explicitVersion: '1.16.0-rc.1'
      })
      assert.equal(result.resolved, true)
      if (result.resolved) {
        assert.equal(result.runtime.version, '1.16.0-rc.1')
      }
    })
  })
})

describe('checkAbi', () => {
  const addon = {
    name: 'bare-os',
    version: '3.9.0',
    packageJsonPath: '/x/package.json',
    packageRoot: '/x',
    enginesBare: '>=1.14.0'
  }

  it('returns empty when no addon declares engines.bare', () => {
    const result = checkAbi({
      addons: [{ ...addon, enginesBare: undefined }],
      runtime: resolution('1.15.0')
    })
    assert.deepEqual(result, [])
  })

  it('emits an abi-mismatch when the runtime is out of range', () => {
    const result = checkAbi({ addons: [addon], runtime: resolution('1.13.5') })
    assert.equal(result.length, 1)
    assert.equal(result[0]?.code, 'abi-mismatch')
  })

  it('passes when the runtime satisfies the declared range', () => {
    const result = checkAbi({ addons: [addon], runtime: resolution('1.14.5') })
    assert.deepEqual(result, [])
  })

  it('warns once when runtime is unknown but addons declare engines.bare', () => {
    const result = checkAbi({
      addons: [addon],
      runtime: { resolved: false, error: { reason: 'unknown', triedPaths: [] } }
    })
    assert.equal(result.length, 1)
    assert.equal(result[0]?.code, 'unknown-runtime-version')
    assert.equal(result[0]?.level, 'warning')
  })

  it('emits malformed-engines-bare warning (not error) for an unparseable engines.bare range', () => {
    const malformed = { ...addon, enginesBare: 'garbage' }
    const result = checkAbi({
      addons: [malformed],
      runtime: resolution('1.15.0')
    })
    assert.equal(result.length, 1)
    assert.equal(result[0]?.code, 'malformed-engines-bare')
    assert.equal(result[0]?.level, 'warning')
    if (result[0]?.code === 'malformed-engines-bare') {
      assert.equal(result[0].enginesBare, 'garbage')
      assert.match(result[0].message, /bare-os@3\.9\.0/)
      assert.match(result[0].message, /not a valid semver range/)
    }
  })

  it('reports malformed-engines-bare for one addon without blocking abi checks on others', () => {
    const good = { ...addon, name: 'bare-fs', enginesBare: '>=1.16.0' }
    const malformed = { ...addon, name: 'bare-tcp', enginesBare: 'not-a-range' }
    const result = checkAbi({
      addons: [good, malformed],
      runtime: resolution('1.15.0')
    })
    const codes = result.map((issue) => issue.code).sort()
    assert.deepEqual(codes, ['abi-mismatch', 'malformed-engines-bare'])
  })

  it('surfaces malformed-engines-bare even when runtime is unknown', () => {
    const malformed = { ...addon, enginesBare: 'garbage' }
    const valid = { ...addon, name: 'bare-fs', enginesBare: '>=1.16.0' }
    const result = checkAbi({
      addons: [malformed, valid],
      runtime: { resolved: false, error: { reason: 'unknown', triedPaths: [] } }
    })
    const codes = result.map((issue) => issue.code).sort()
    assert.deepEqual(codes, ['malformed-engines-bare', 'unknown-runtime-version'])
  })

  it('omits unknown-runtime-version when every addon has malformed engines.bare and runtime is unknown', () => {
    const malformed1 = { ...addon, name: 'bare-fs', enginesBare: 'garbage' }
    const malformed2 = { ...addon, name: 'bare-tcp', enginesBare: 'also-garbage' }
    const result = checkAbi({
      addons: [malformed1, malformed2],
      runtime: { resolved: false, error: { reason: 'unknown', triedPaths: [] } }
    })
    assert.equal(result.length, 2)
    assert.equal(
      result.every((issue) => issue.code === 'malformed-engines-bare'),
      true
    )
  })
})

function resolution(version: string): BareRuntimeResolution {
  return { resolved: true, runtime: { version, source: 'flag' } }
}

describe('verifyBundle orchestrator', () => {
  it('emits invalid-source when --addons-source path is missing', async () => {
    await withTempDir(async (dir) => {
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: 'nope',
        hosts: ['ios-arm64']
      })
      assert.equal(hasErrors(result), true)
      assert.equal(result.issues[0]?.code, 'invalid-source')
    })
  })

  it('emits invalid-source when no hosts are provided', async () => {
    await withTempDir(async (dir) => {
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: dir,
        hosts: []
      })
      assert.equal(hasErrors(result), true)
      assert.equal(result.issues[0]?.code, 'invalid-source')
    })
  })

  it('emits invalid-runtime-version error (not warning) when --bare-runtime-version is malformed', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        bareRuntimeVersion: 'not-a-version'
      })
      assert.equal(hasErrors(result), true)
      assert.equal(result.issues.length, 1)
      assert.equal(result.issues[0]?.code, 'invalid-runtime-version')
      assert.equal(
        result.issues[0]?.code === 'invalid-runtime-version' && result.issues[0]?.providedValue,
        'not-a-version'
      )
    })
  })

  it('emits invalid-runtime-version even when no addon declares engines.bare', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        bareRuntimeVersion: 'garbage'
      })
      assert.equal(hasErrors(result), true)
      assert.equal(result.issues[0]?.code, 'invalid-runtime-version')
    })
  })

  it('accepts lenient explicit versions like "v1.15" via semver coercion', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        bareRuntimeVersion: 'v1.15'
      })
      assert.equal(hasErrors(result), false)
    })
  })

  it('passes a happy-path bundle with prebuilds and a satisfying runtime', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      writePrebuild(packageRoot, 'ios-arm64')
      writePrebuild(packageRoot, 'android-arm64')
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, { '/node_modules/bare-os/index.js': true })

      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['ios-arm64', 'android-arm64'],
        bareRuntimeVersion: '1.15.0'
      })
      assert.equal(hasErrors(result), false)
      assert.equal(hasWarnings(result), false)
      assert.equal(result.addons.length, 1)
    })
  })

  it('fails when the bundle source has missing prebuilds', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, { '/node_modules/bare-os/index.js': true })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['ios-arm64-simulator']
      })
      assert.equal(hasErrors(result), true)
      assert.equal(
        result.issues.some((i) => i.code === 'missing-prebuild'),
        true
      )
    })
  })

  it('passes a bundle whose addon ships its prebuilds in per-platform packages', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/@qvac/tts-ggml', {
        ...splitTtsManifest(),
        engines: { bare: '>=1.19.0' }
      })
      writePlatformPackage(dir, 'node_modules/@qvac/tts-ggml-darwin-arm64', {
        name: '@qvac/tts-ggml-darwin-arm64',
        addon: '@qvac/tts-ggml',
        hosts: ['darwin-arm64']
      })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, { '/node_modules/@qvac/tts-ggml/index.js': true })

      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['darwin-arm64'],
        bareRuntimeVersion: '1.30.3'
      })
      assert.equal(hasErrors(result), false)
      assert.equal(hasWarnings(result), false)
      assert.deepEqual(
        result.addons.map((addon) => addon.name),
        ['@qvac/tts-ggml'],
        'only the meta package is an addon; the platform package is not double-counted'
      )
    })
  })

  it('fails when node_modules source has an abi mismatch', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        bareRuntimeVersion: '1.13.0'
      })
      assert.equal(hasErrors(result), true)
      assert.equal(
        result.issues.some((i) => i.code === 'abi-mismatch'),
        true
      )
    })
  })

  it('warns (not fails) when runtime is unknown but addons declare engines.bare', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64']
      })
      assert.equal(hasErrors(result), false)
      assert.equal(hasWarnings(result), true)
      assert.equal(
        result.issues.some((i) => i.code === 'unknown-runtime-version'),
        true
      )
    })
  })

  it('invalid bareRuntimeVersion does not short-circuit prebuild checks', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        bareRuntimeVersion: 'not-a-version'
      })
      assert.equal(hasErrors(result), true)
      assert.equal(
        result.issues.some((i) => i.code === 'invalid-runtime-version'),
        true
      )
      assert.equal(
        result.issues.some((i) => i.code === 'missing-prebuild'),
        true,
        'prebuild walk must still surface missing prebuilds when bareRuntimeVersion is malformed'
      )
      assert.equal(result.runtime, null)
    })
  })

  it('emits empty-bundle-resolutions warning when bundle source has no resolutions', async () => {
    await withTempDir(async (dir) => {
      const bundlePath = path.join(dir, 'qvac', 'worker.bundle.js')
      writeBareBundle(bundlePath, {})
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['darwin-arm64']
      })
      assert.equal(hasErrors(result), false)
      assert.equal(hasWarnings(result), true)
      const warning = result.issues.find((i) => i.code === 'empty-bundle-resolutions')
      assert.ok(warning, 'expected empty-bundle-resolutions warning')
      if (warning?.code === 'empty-bundle-resolutions') {
        assert.equal(warning.level, 'warning')
        assert.equal(warning.bundlePath, bundlePath)
      }
      assert.equal(result.addons.length, 0)
    })
  })

  it('passes on a single-host bundle that resolved the addon away', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir, { hosts: ['win32-x64'] })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, singleHostResolutions({ linked: false }), { main: BUNDLE_MAIN })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['win32-x64']
      })
      assert.deepEqual(
        result.issues.filter((i) => i.code === 'missing-prebuild'),
        []
      )
      assert.equal(hasErrors(result), false)
    })
  })

  it('reports the missing prebuild on a host that does link the addon', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir, { hosts: ['linux-x64'] })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, singleHostResolutions({ linked: true }), { main: BUNDLE_MAIN })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['linux-x64']
      })
      const missing = result.issues.filter((i) => i.code === 'missing-prebuild')
      assert.equal(missing.length, 1)
      assert.equal(missing[0]?.code === 'missing-prebuild' && missing[0]?.addon, 'bare-posix@1.0.1')
      assert.equal(hasErrors(result), true)
    })
  })

  it('splits the verdict per host on a multi-host bundle', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir, { hosts: ['win32-x64', 'linux-x64'] })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, multiHostResolutions(), { main: BUNDLE_MAIN })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['win32-x64', 'linux-x64']
      })
      const missing = result.issues.filter((i) => i.code === 'missing-prebuild')
      assert.deepEqual(
        missing.map((i) => (i.code === 'missing-prebuild' ? `${i.addon}/${i.host}` : '')),
        ['bare-posix@1.0.1/linux-x64']
      )
    })
  })

  it('keeps every host checked when the bundle header has no main to walk from', async () => {
    await withTempDir(async (dir) => {
      writeGraphPackages(dir, { hosts: ['win32-x64', 'linux-x64'] })
      const bundlePath = path.join(dir, 'worker.bundle.js')
      writeBareBundle(bundlePath, multiHostResolutions())
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: bundlePath,
        hosts: ['win32-x64', 'linux-x64']
      })
      assert.deepEqual(
        result.issues
          .filter((i) => i.code === 'missing-prebuild')
          .map((i) => (i.code === 'missing-prebuild' ? `${i.addon}/${i.host}` : '')),
        ['bare-posix@1.0.1/win32-x64', 'bare-posix@1.0.1/linux-x64']
      )
    })
  })
})

describe('verifyBundle config source', () => {
  it('reads bareRuntimeVersion from auto-detected qvac.config.json', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      writeJson(path.join(dir, 'qvac.config.json'), { bareRuntimeVersion: '1.15.0' })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64']
      })
      assert.equal(hasErrors(result), false)
      assert.equal(hasWarnings(result), false)
      assert.equal(result.runtime?.resolved, true)
      if (result.runtime?.resolved) {
        assert.equal(result.runtime.runtime.source, 'config')
        assert.equal(result.runtime.runtime.version, '1.15.0')
      }
    })
  })

  it('explicit bareRuntimeVersion overrides config bareRuntimeVersion', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      writeJson(path.join(dir, 'qvac.config.json'), { bareRuntimeVersion: '1.13.0' })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        bareRuntimeVersion: '1.15.0'
      })
      assert.equal(hasErrors(result), false)
      if (result.runtime?.resolved) {
        assert.equal(result.runtime.runtime.source, 'flag')
        assert.equal(result.runtime.runtime.version, '1.15.0')
      }
    })
  })

  it('configPath option loads a non-default config location', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      const customConfigPath = path.join(dir, 'tools', 'qvac.config.json')
      writeJson(customConfigPath, { bareRuntimeVersion: '1.15.0' })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        configPath: customConfigPath
      })
      assert.equal(hasErrors(result), false)
      if (result.runtime?.resolved) {
        assert.equal(result.runtime.runtime.source, 'config')
      }
    })
  })

  it('emits invalid-runtime-version (source: config) when config bareRuntimeVersion is malformed', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      writeJson(path.join(dir, 'qvac.config.json'), { bareRuntimeVersion: 'garbage' })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64']
      })
      assert.equal(hasErrors(result), true)
      assert.equal(result.issues.length, 1)
      const issue = result.issues[0]
      assert.equal(issue?.code, 'invalid-runtime-version')
      if (issue?.code === 'invalid-runtime-version') {
        assert.equal(issue.source, 'config')
        assert.equal(issue.providedValue, 'garbage')
        assert.match(issue.message, /qvac\.config\.json/)
      }
    })
  })

  it('includes the explicit configPath in invalid-runtime-version messages', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      const customConfigPath = path.join(dir, 'tools', 'custom.json')
      writeJson(customConfigPath, { bareRuntimeVersion: 'garbage' })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        configPath: path.join('tools', 'custom.json')
      })
      assert.equal(hasErrors(result), true)
      const issue = result.issues[0]
      assert.equal(issue?.code, 'invalid-runtime-version')
      if (issue?.code === 'invalid-runtime-version') {
        assert.equal(issue.source, 'config')
        assert.match(issue.message, /tools\/custom\.json/)
      }
    })
  })

  it('ignores non-string bareRuntimeVersion in config and falls through to auto-detect', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      writeJson(path.join(dir, 'qvac.config.json'), { bareRuntimeVersion: 12345 })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64']
      })
      assert.equal(hasErrors(result), false)
      assert.equal(hasWarnings(result), true)
      assert.equal(
        result.issues.some((i) => i.code === 'unknown-runtime-version'),
        true
      )
    })
  })

  it('emits invalid-source when explicit --config path does not exist', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64'],
        configPath: 'nope.config.json'
      })
      assert.equal(hasErrors(result), true)
      assert.equal(result.issues[0]?.code, 'invalid-source')
      assert.match(result.issues[0]?.message ?? '', /nope\.config\.json/)
    })
  })

  it('emits config-load-failed (warning, not error) when an auto-detected config fails to load', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      writePrebuild(packageRoot, 'darwin-arm64')
      writeJson(path.join(dir, 'node_modules', 'bare-runtime', 'package.json'), {
        name: 'bare-runtime',
        version: '1.15.0'
      })
      fs.writeFileSync(path.join(dir, 'qvac.config.json'), '{ "bareRuntimeVersion": ')
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['darwin-arm64']
      })
      assert.equal(hasErrors(result), false)
      assert.equal(hasWarnings(result), true)
      const warning = result.issues.find((i) => i.code === 'config-load-failed')
      assert.ok(warning, 'expected config-load-failed warning')
      if (warning?.code === 'config-load-failed') {
        assert.equal(warning.level, 'warning')
        assert.equal(warning.configPath, path.join(dir, 'qvac.config.json'))
        assert.match(warning.message, /qvac\.config\.json/)
      }
      assert.equal(result.runtime?.resolved, true)
      if (result.runtime?.resolved) {
        assert.equal(result.runtime.runtime.source, 'bare-runtime')
      }
    })
  })
})

describe('formatVerifyBundleResult', () => {
  it('renders a success summary when there are no issues', async () => {
    await withTempDir(async (dir) => {
      const packageRoot = writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      writePrebuild(packageRoot, 'ios-arm64')
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['ios-arm64']
      })
      const out = formatVerifyBundleResult(result)
      assert.match(out, /Native addon verification passed/)
      assert.match(out, /bare-os@3\.9\.0/)
    })
  })

  it('renders the failure summary with Missing prebuild and ABI mismatch sections', async () => {
    await withTempDir(async (dir) => {
      writePackageJson(dir, 'node_modules/bare-os', {
        name: 'bare-os',
        version: '3.9.0',
        addon: true,
        engines: { bare: '>=1.14.0' }
      })
      const result = await verifyBundle({
        projectRoot: dir,
        addonsSource: path.join(dir, 'node_modules'),
        hosts: ['ios-arm64-simulator'],
        bareRuntimeVersion: '1.13.0'
      })
      const out = formatVerifyBundleResult(result)
      assert.match(out, /Native addon verification failed/)
      assert.match(out, /Missing prebuild/)
      assert.match(out, /ABI mismatch/)
      assert.match(out, /bare-os@3\.9\.0 for ios-arm64-simulator/)
      assert.match(out, /requires bare >=1\.14\.0, runtime is 1\.13\.0/)
    })
  })
})
