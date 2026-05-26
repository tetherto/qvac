import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deduplicateAddons,
  formatAddonId,
  readAddonPackageJson
} from "@/commands/verify/addon-source";
import {
  collectAddonsFromBundle,
  InvalidBundleSourceError,
} from "@/commands/verify/bundle-source";
import {
  collectAddonsFromNodeModules,
  InvalidNodeModulesSourceError,
} from "@/commands/verify/node-modules-source";
import { checkPrebuilds } from "@/commands/verify/prebuilds";
import {
  checkAbi,
  resolveBareRuntime,
  type BareRuntimeResolution,
} from "@/commands/verify/abi";
import {
  formatVerifyBundleResult,
  hasErrors,
  hasWarnings,
  verifyBundle,
} from "@/commands/verify/index";

async function withTempDir (fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-verify-bundle-'))
  )
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeJson (filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function writePackageJson (
  projectRoot: string,
  relPackageDir: string,
  body: Record<string, unknown>
): string {
  const packageJsonPath = path.join(projectRoot, relPackageDir, 'package.json')
  writeJson(packageJsonPath, body)
  return path.join(projectRoot, relPackageDir)
}

function writePrebuild (
  packageRoot: string,
  host: string,
  filename = 'native.bare'
): void {
  const dir = path.join(packageRoot, 'prebuilds', host)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, filename), '')
}

function escapeForJsString (s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

function writeBareBundle (
  bundlePath: string,
  resolutions: Record<string, unknown>,
  options: { id?: string, body?: string } = {}
): void {
  const bundleId = options.id ?? 'test-bundle-id'
  const header = JSON.stringify({ id: bundleId, resolutions })
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
        () => collectAddonsFromBundle({
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
      assert.deepEqual(
        addons.map((a) => a.version).sort(),
        ['3.9.0', '4.0.0']
      )
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
})

describe('collectAddonsFromNodeModules', () => {
  it('throws InvalidNodeModulesSourceError when the root is missing', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(
        () => collectAddonsFromNodeModules({
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
      assert.deepEqual(result.map((r) => r.name), ['bare-os'])
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
      fs.symlinkSync(
        path.join(store, 'bare-os-real'),
        path.join(nm, 'bare-os'),
        'dir'
      )
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
      assert.deepEqual(
        issues.map((i) => i.host).sort(),
        ['android-arm64', 'ios-arm64-simulator']
      )
    })
  })
})

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
      writeJson(
        path.join(dir, 'node_modules', 'bare-runtime', 'package.json'),
        { name: 'bare-runtime', version: '1.16.0' }
      )
      const result = await resolveBareRuntime({ projectRoot: dir })
      assert.equal(result.resolved, true)
      if (result.resolved) assert.equal(result.runtime.source, 'bare-runtime')
    })
  })

  it('prefers bare-runtime over bare when both are installed', async () => {
    await withTempDir(async (dir) => {
      writeJson(
        path.join(dir, 'node_modules', 'bare-runtime', 'package.json'),
        { name: 'bare-runtime', version: '1.16.0' }
      )
      writeJson(
        path.join(dir, 'node_modules', 'bare', 'package.json'),
        { name: 'bare', version: '1.15.0' }
      )
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
      writeJson(
        path.join(dir, 'node_modules', 'bare', 'package.json'),
        { name: 'bare', version: '1.15.0' }
      )
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

function resolution (version: string): BareRuntimeResolution {
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
        result.issues[0]?.code === 'invalid-runtime-version' &&
          result.issues[0]?.providedValue,
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
      writeJson(
        path.join(dir, 'node_modules', 'bare-runtime', 'package.json'),
        { name: 'bare-runtime', version: '1.15.0' }
      )
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
