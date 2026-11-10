import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledSdkMismatch, bundledTarget, installedSdkVersion } from '@/client/rpc/bundle-stamp'

const SDK_MANIFEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json')

function bundleWith(t: { after: (fn: () => void) => void }, manifest: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-bundle-stamp-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

describe('installedSdkVersion', () => {
  it('reads the SDK version from the source layout', () => {
    const { version } = JSON.parse(fs.readFileSync(SDK_MANIFEST, 'utf8'))
    assert.equal(installedSdkVersion(), version)
  })

  it('reads the package root from the built layout, which has no dist/package.json', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-installed-version-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@qvac/sdk', version: '9.9.9' })
    )
    const built = path.join(root, 'dist', 'src', 'client', 'rpc')
    fs.mkdirSync(built, { recursive: true })

    assert.equal(installedSdkVersion(built), '9.9.9')
  })

  it('has no version when the SDK was bundled into an app', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-installed-version-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'app', version: '1.0.0' })
    )

    assert.equal(installedSdkVersion(root), undefined)
  })
})

describe('bundledTarget', () => {
  it('reads the target the worker was bundled for', (t) => {
    assert.equal(bundledTarget(bundleWith(t, { qvacTarget: 'pear-runtime' })), 'pear-runtime')
  })

  it('is undefined for a worker that does not record it', (t) => {
    assert.equal(bundledTarget(bundleWith(t, {})), undefined)
  })
})

describe('bundledSdkMismatch', () => {
  it('accepts a worker bundled by the installed SDK', (t) => {
    const dir = bundleWith(t, { qvacSdkVersion: '0.24.0' })
    assert.equal(bundledSdkMismatch(dir, '0.24.0'), null)
  })

  it('names both versions when the worker was bundled by another SDK', (t) => {
    const dir = bundleWith(t, { qvacSdkVersion: '0.23.0' })
    const warning = bundledSdkMismatch(dir, '0.24.0')
    assert.ok(warning?.includes('@qvac/sdk 0.23.0'))
    assert.ok(warning?.includes('@qvac/sdk 0.24.0 is installed'))
    assert.ok(warning?.includes('qvac bundle sdk'))
  })

  it('flags a worker that records no SDK version', (t) => {
    const dir = bundleWith(t, {})
    assert.ok(bundledSdkMismatch(dir, '0.24.0')?.includes('an older @qvac/sdk'))
  })

  it('stays quiet when the bundle has no readable package.json', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-bundle-stamp-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    assert.equal(bundledSdkMismatch(dir, '0.24.0'), null)
  })
})
