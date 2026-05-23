import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSdkPackageDir } from '../src/bundle-sdk/resolve-sdk-package-dir.js'
import {
  SdkNotFoundInNodeModulesError,
  MultipleSdkInstallationsError
} from '../src/errors.js'

/*
 * Sister suite: packages/sdk/test/unit/resolve-sdk-package-dir.test.ts
 *
 * Both files exercise the same resolution semantics against the same set of
 * filesystem layouts. Keep them in sync.
 */

function installPackage (parentDir: string, name: string): string {
  const pkgDir = path.join(parentDir, 'node_modules', ...name.split('/'))
  fs.mkdirSync(pkgDir, { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {}')
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name, main: 'index.js' })
  )
  return pkgDir
}

function withTempProject (
  fn: (projectRoot: string, workspaceRoot: string) => void
): void {
  const workspaceRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-cli-resolve-sdk-'))
  )
  const projectRoot = path.join(workspaceRoot, 'mobile')
  fs.mkdirSync(projectRoot)
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'mobile' })
  )
  try {
    fn(projectRoot, workspaceRoot)
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  }
}

function captureWarnings (fn: () => void): string[] {
  const original = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    fn()
  } finally {
    console.warn = original
  }
  return warnings
}

describe('resolveSdkPackageDir', () => {
  it('resolves @qvac/sdk when installed at projectRoot', () => {
    withTempProject((projectRoot) => {
      const expected = installPackage(projectRoot, '@qvac/sdk')
      const warnings = captureWarnings(() => {
        const result = resolveSdkPackageDir(projectRoot)
        assert.equal(result.name, '@qvac/sdk')
        assert.equal(result.dir, expected)
      })
      assert.equal(warnings.length, 0)
    })
  })

  it('resolves @tetherto/sdk-mono when installed at projectRoot', () => {
    withTempProject((projectRoot) => {
      const expected = installPackage(projectRoot, '@tetherto/sdk-mono')
      const result = resolveSdkPackageDir(projectRoot)
      assert.equal(result.name, '@tetherto/sdk-mono')
      assert.equal(result.dir, expected)
    })
  })

  it('walks ancestors and resolves a hoisted install', () => {
    withTempProject((projectRoot, workspaceRoot) => {
      const expected = installPackage(workspaceRoot, '@qvac/sdk')
      const warnings = captureWarnings(() => {
        const result = resolveSdkPackageDir(projectRoot)
        assert.equal(result.name, '@qvac/sdk')
        assert.equal(result.dir, expected)
      })
      assert.equal(warnings.length, 0)
    })
  })

  it('prefers projectRoot copy over a hoisted ancestor copy and warns', () => {
    withTempProject((projectRoot, workspaceRoot) => {
      const expected = installPackage(projectRoot, '@qvac/sdk')
      const shadowed = installPackage(workspaceRoot, '@qvac/sdk')
      const warnings = captureWarnings(() => {
        const result = resolveSdkPackageDir(projectRoot)
        assert.equal(result.name, '@qvac/sdk')
        assert.equal(result.dir, expected)
      })
      assert.equal(warnings.length, 1)
      assert.ok(warnings[0]!.includes(shadowed))
      assert.ok(warnings[0]!.includes(expected))
    })
  })

  it('prefers the closest install when two different SDK packages live at different depths', () => {
    withTempProject((projectRoot, workspaceRoot) => {
      const expected = installPackage(projectRoot, '@qvac/sdk')
      installPackage(workspaceRoot, '@tetherto/sdk-dev')
      const warnings = captureWarnings(() => {
        const result = resolveSdkPackageDir(projectRoot)
        assert.equal(result.name, '@qvac/sdk')
        assert.equal(result.dir, expected)
      })
      assert.equal(warnings.length, 1)
      assert.ok(warnings[0]!.includes('@tetherto/sdk-dev'))
    })
  })

  it('throws MultipleSdkInstallationsError when two different SDK packages share the closest depth', () => {
    withTempProject((projectRoot) => {
      installPackage(projectRoot, '@qvac/sdk')
      installPackage(projectRoot, '@tetherto/sdk-dev')
      assert.throws(
        () => resolveSdkPackageDir(projectRoot),
        (err: unknown) =>
          err instanceof MultipleSdkInstallationsError &&
          err.message.includes('@qvac/sdk') &&
          err.message.includes('@tetherto/sdk-dev')
      )
    })
  })

  it('throws SdkNotFoundInNodeModulesError when no SDK is installed anywhere', () => {
    withTempProject((projectRoot) => {
      assert.throws(
        () => resolveSdkPackageDir(projectRoot),
        (err: unknown) => err instanceof SdkNotFoundInNodeModulesError
      )
    })
  })
})
