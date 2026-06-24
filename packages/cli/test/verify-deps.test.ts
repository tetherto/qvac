import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertSupportedNpmLockfile,
  collectPackagesFromNpmLock,
  packageNameFromNpmLockPath,
  parseNpmPackageLock,
  UnsupportedLockfileError
} from '../src/verify/deps/npm-lockfile.js'
import {
  collectNativePackages,
  type NativePackage,
  type UnclassifiedPackage
} from '../src/verify/deps/native-packages.js'
import {
  diffUnknownRemovedPackages,
  diffNativePackages,
  formatNativePackage,
  formatVerifyDepsResult,
  hasNativeChanges,
  hasUnclassifiedPackages,
  resolveLockfilePackageRoot,
  verifyDeps
} from '../src/verify/deps/index.js'

async function withTempDir (fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-verify-deps-'))
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

function runGit (cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8'
  }).trim()
}

function nativePackage (name: string, version: string): NativePackage {
  return {
    lockPath: `node_modules/${name}`,
    name,
    version,
    packageJsonPath: `/tmp/node_modules/${name}/package.json`
  }
}

function unclassifiedPackage (name: string, version: string): UnclassifiedPackage {
  return {
    lockPath: `node_modules/${name}`,
    name,
    version,
    packageJsonPath: `/tmp/node_modules/${name}/package.json`,
    reason: 'ENOENT'
  }
}

describe('packageNameFromNpmLockPath', () => {
  it('extracts unscoped package names', () => {
    assert.equal(packageNameFromNpmLockPath('node_modules/bare-os'), 'bare-os')
  })

  it('extracts scoped package names', () => {
    assert.equal(
      packageNameFromNpmLockPath('node_modules/@qvac/registry-client'),
      '@qvac/registry-client'
    )
  })

  it('extracts the nested package name from nested node_modules paths', () => {
    assert.equal(
      packageNameFromNpmLockPath('node_modules/@qvac/sdk/node_modules/bare-os'),
      'bare-os'
    )
  })

  it('ignores non-package lock paths', () => {
    assert.equal(packageNameFromNpmLockPath(''), null)
    assert.equal(packageNameFromNpmLockPath('packages/sdk'), null)
    assert.equal(packageNameFromNpmLockPath('node_modules/@qvac'), null)
  })
})

describe('collectPackagesFromNpmLock', () => {
  it('collects package names and versions from npm lockfile packages', () => {
    const lock = parseNpmPackageLock(JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', version: '1.0.0' },
        'node_modules/bare-os': { version: '3.9.0' },
        'node_modules/@qvac/sdk/node_modules/bare-tcp': { version: '2.2.12' },
        'packages/sdk': { version: '0.10.1' }
      }
    }))

    assert.deepEqual(collectPackagesFromNpmLock(lock), [
      { lockPath: 'node_modules/bare-os', name: 'bare-os', version: '3.9.0' },
      {
        lockPath: 'node_modules/@qvac/sdk/node_modules/bare-tcp',
        name: 'bare-tcp',
        version: '2.2.12'
      }
    ])
  })
})

describe('assertSupportedNpmLockfile', () => {
  it('accepts npm package-lock paths', () => {
    assert.doesNotThrow(() => assertSupportedNpmLockfile('package-lock.json'))
    assert.doesNotThrow(() => assertSupportedNpmLockfile('packages/sdk/package-lock.json'))
  })

  it('rejects unsupported lockfiles explicitly', () => {
    assert.throws(
      () => assertSupportedNpmLockfile('bun.lock'),
      UnsupportedLockfileError
    )
    assert.throws(
      () => assertSupportedNpmLockfile('yarn.lock'),
      /currently supports npm package-lock\.json/
    )
  })
})

describe('collectNativePackages', () => {
  it('classifies packages whose package.json declares addon true', async () => {
    await withTempDir(async (projectRoot) => {
      writeJson(path.join(projectRoot, 'node_modules/bare-os/package.json'), {
        name: 'bare-os',
        version: '3.9.0',
        addon: true
      })
      writeJson(path.join(projectRoot, 'node_modules/mqtt/package.json'), {
        name: 'mqtt',
        version: '5.14.1'
      })

      const result = await collectNativePackages({
        projectRoot,
        packages: [
          { lockPath: 'node_modules/bare-os', name: 'bare-os', version: '3.9.0' },
          { lockPath: 'node_modules/mqtt', name: 'mqtt', version: '5.14.1' }
        ]
      })

      assert.deepEqual(result.nativePackages.map(formatNativePackage), [
        'bare-os@3.9.0'
      ])
      assert.equal(result.unclassifiedPackages.length, 0)
    })
  })

  it('keeps missing package metadata separate from non-native packages', async () => {
    await withTempDir(async (projectRoot) => {
      const result = await collectNativePackages({
        projectRoot,
        packages: [
          { lockPath: 'node_modules/missing-native', name: 'missing-native', version: '1.0.0' }
        ]
      })

      assert.equal(result.nativePackages.length, 0)
      assert.equal(result.unclassifiedPackages.length, 1)
      assert.equal(result.unclassifiedPackages[0]?.name, 'missing-native')
    })
  })
})

describe('diffNativePackages', () => {
  it('diffs native package name and version pairs', () => {
    const result = diffNativePackages(
      [
        nativePackage('bare-os', '3.8.0'),
        nativePackage('bare-crypto', '1.13.5')
      ],
      [
        nativePackage('bare-os', '3.9.0'),
        nativePackage('bare-crypto', '1.13.5'),
        nativePackage('bare-tcp', '2.2.12')
      ]
    )

    assert.deepEqual(result.added.map(formatNativePackage), [
      'bare-os@3.9.0',
      'bare-tcp@2.2.12'
    ])
    assert.deepEqual(result.removed.map(formatNativePackage), [
      'bare-os@3.8.0'
    ])
    assert.deepEqual(result.unchanged.map(formatNativePackage), [
      'bare-crypto@1.13.5'
    ])
    assert.deepEqual(result.unknownRemoved, [])
  })
})

describe('diffUnknownRemovedPackages', () => {
  it('reports removed packages when native status cannot be classified', () => {
    const result = diffUnknownRemovedPackages(
      [
        unclassifiedPackage('bare-old', '1.0.0'),
        unclassifiedPackage('left-pad', '1.3.0')
      ],
      [
        { lockPath: 'node_modules/left-pad', name: 'left-pad', version: '1.3.0' }
      ]
    )

    assert.deepEqual(result.map(formatNativePackage), [
      'bare-old@1.0.0'
    ])
  })
})

describe('resolveLockfilePackageRoot', () => {
  it('uses the current project root for a root package-lock', () => {
    const projectRoot = path.join('/repo', 'app')
    assert.equal(
      resolveLockfilePackageRoot(projectRoot, 'package-lock.json'),
      projectRoot
    )
  })

  it('uses the lockfile directory for nested package-lock paths', () => {
    const projectRoot = path.join('/repo')
    assert.equal(
      resolveLockfilePackageRoot(projectRoot, 'packages/sdk/package-lock.json'),
      path.join(projectRoot, 'packages', 'sdk')
    )
  })
})

describe('verifyDeps', () => {
  it('reports removed packages when HEAD node_modules no longer has package metadata', async () => {
    await withTempDir(async (projectRoot) => {
      runGit(projectRoot, ['init', '-b', 'main'])
      runGit(projectRoot, ['config', 'user.email', 'qvac-test@example.com'])
      runGit(projectRoot, ['config', 'user.name', 'QVAC Test'])

      writeJson(path.join(projectRoot, 'package-lock.json'), {
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', version: '1.0.0' },
          'node_modules/bare-old': { version: '1.0.0' }
        }
      })
      runGit(projectRoot, ['add', 'package-lock.json'])
      runGit(projectRoot, ['commit', '-m', 'base lockfile'])
      const base = runGit(projectRoot, ['rev-parse', 'HEAD'])

      writeJson(path.join(projectRoot, 'package-lock.json'), {
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', version: '1.0.0' }
        }
      })
      runGit(projectRoot, ['add', 'package-lock.json'])
      runGit(projectRoot, ['commit', '-m', 'head lockfile'])
      const head = runGit(projectRoot, ['rev-parse', 'HEAD'])

      const result = await verifyDeps({ projectRoot, base, head })
      const output = formatVerifyDepsResult(result)

      assert.equal(hasNativeChanges(result), true)
      assert.deepEqual(result.diff.unknownRemoved.map(formatNativePackage), [
        'bare-old@1.0.0'
      ])
      assert.match(output, /Removed \(unknown native status\)/)
    })
  })
})

describe('formatVerifyDepsResult', () => {
  it('formats native additions and removals', () => {
    const output = formatVerifyDepsResult({
      base: 'upstream/main',
      head: 'HEAD',
      diff: {
        added: [nativePackage('bare-tcp', '2.2.12')],
        removed: [nativePackage('bare-os', '3.8.0')],
        unchanged: [],
        unknownRemoved: []
      },
      unclassifiedBase: [],
      unclassifiedHead: []
    })

    assert.equal(hasNativeChanges({
      base: 'upstream/main',
      head: 'HEAD',
      diff: {
        added: [nativePackage('bare-tcp', '2.2.12')],
        removed: [],
        unchanged: [],
        unknownRemoved: []
      },
      unclassifiedBase: [],
      unclassifiedHead: []
    }), true)
    assert.match(output, /Native addon changes between upstream\/main\.\.HEAD/)
    assert.match(output, /\+ bare-tcp@2\.2\.12/)
    assert.match(output, /- bare-os@3\.8\.0/)
    assert.match(output, /qvac verify bundle/)
  })

  it('formats removed packages whose native status is unknown', () => {
    const removed = unclassifiedPackage('bare-old', '1.0.0')
    const result = {
      base: 'origin/main',
      head: 'HEAD',
      diff: {
        added: [],
        removed: [],
        unchanged: [],
        unknownRemoved: [removed]
      },
      unclassifiedBase: [removed],
      unclassifiedHead: []
    }
    const output = formatVerifyDepsResult(result)

    assert.equal(hasNativeChanges(result), true)
    assert.match(output, /Removed \(unknown native status\) \(1\):/)
    assert.match(output, /\? bare-old@1\.0\.0/)
    assert.doesNotMatch(output, /Warning:/)
  })

  it('formats no native changes', () => {
    const output = formatVerifyDepsResult({
      base: 'origin/main',
      head: 'HEAD',
      diff: { added: [], removed: [], unchanged: [], unknownRemoved: [] },
      unclassifiedBase: [],
      unclassifiedHead: []
    })

    assert.equal(output, 'No native addon changes between origin/main..HEAD.')
  })

  it('suppresses unclassified package warnings when there are no native changes', () => {
    const output = formatVerifyDepsResult({
      base: 'origin/main',
      head: 'HEAD',
      diff: { added: [], removed: [], unchanged: [], unknownRemoved: [] },
      unclassifiedBase: [],
      unclassifiedHead: [{
        lockPath: 'node_modules/missing-native',
        name: 'missing-native',
        version: '1.0.0',
        packageJsonPath: '/repo/node_modules/missing-native/package.json',
        reason: 'ENOENT'
      }]
    })

    const resultHasUnclassified = hasUnclassifiedPackages({
      base: 'origin/main',
      head: 'HEAD',
      diff: { added: [], removed: [], unchanged: [], unknownRemoved: [] },
      unclassifiedBase: [],
      unclassifiedHead: [{
        lockPath: 'node_modules/missing-native',
        name: 'missing-native',
        version: '1.0.0',
        packageJsonPath: '/repo/node_modules/missing-native/package.json',
        reason: 'ENOENT'
      }]
    })
    assert.equal(resultHasUnclassified, true)
    assert.equal(output, 'No native addon changes between origin/main..HEAD.')
  })

  it('formats unclassified package warnings when native changes are present', () => {
    const output = formatVerifyDepsResult({
      base: 'origin/main',
      head: 'HEAD',
      diff: {
        added: [nativePackage('bare-tcp', '2.2.12')],
        removed: [],
        unchanged: [],
        unknownRemoved: []
      },
      unclassifiedBase: [],
      unclassifiedHead: [{
        lockPath: 'node_modules/missing-native',
        name: 'missing-native',
        version: '1.0.0',
        packageJsonPath: '/repo/node_modules/missing-native/package.json',
        reason: 'ENOENT'
      }]
    })

    assert.match(output, /\+ bare-tcp@2\.2\.12/)
    assert.match(output, /Warning: 1 package could not be classified/)
    assert.match(output, /dependencies installed/)
  })

  it('formats skipped lockfile diffs', () => {
    const output = formatVerifyDepsResult({
      base: 'origin/main',
      head: 'HEAD',
      diff: { added: [], removed: [], unchanged: [], unknownRemoved: [] },
      unclassifiedBase: [],
      unclassifiedHead: [],
      skippedReason:
        'No package-lock.json found at either origin/main or HEAD; native dependency diff skipped.'
    })

    assert.match(output, /native dependency diff skipped/)
  })
})
