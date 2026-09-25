import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkBareEngines } from '@/doctor/checks/engines'

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-doctor-engines-')))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writePackage(projectRoot: string, relDir: string, body: Record<string, unknown>): void {
  const dir = path.join(projectRoot, relDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(body))
}

function writeMobileProject(projectRoot: string, reactNativeBareKit: string): void {
  writePackage(projectRoot, '.', { name: 'app', version: '1.0.0' })
  fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), '{}')
  writePackage(projectRoot, 'node_modules/react-native-bare-kit', {
    name: 'react-native-bare-kit',
    version: reactNativeBareKit
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
  writePackage(projectRoot, 'node_modules/bare-type', {
    name: 'bare-type',
    version: '1.4.0',
    addon: true,
    engines: { bare: '>=1.32.0' }
  })
}

describe('checkBareEngines', () => {
  it('fails with upgrade advice when react-native-bare-kit embeds an older Bare', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, '0.14.5')
      const result = await checkBareEngines(dir, { network: false })
      assert.equal(result.status, 'fail')
      assert.equal(result.severity, 'required')
      assert.match(
        result.hint ?? '',
        /bare-type@1\.4\.0 requires bare >=1\.32\.0, runtime is 1\.29\.4/
      )
      assert.match(result.hint ?? '', /Upgrade react-native-bare-kit to 0\.15\.1 or newer/)
      assert.match(result.detail ?? '', /android-arm64, ios-arm64: Bare 1\.29\.4/)
    })
  })

  it('passes when the embedded Bare satisfies every engines.bare', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, '0.15.1')
      const result = await checkBareEngines(dir, { network: false })
      assert.equal(result.status, 'pass')
      assert.match(result.value ?? '', /android-arm64, ios-arm64: Bare 1\.33\.1/)
    })
  })

  it('reports progress before the node_modules scan', async () => {
    await withTempDir(async (dir) => {
      writeMobileProject(dir, '0.15.1')
      const progress: string[] = []
      await checkBareEngines(dir, { network: false, onProgress: (m) => progress.push(m) })
      assert.ok(progress.some((message) => message.startsWith('Scanning ')))
    })
  })

  it('skips a project without node_modules', async () => {
    await withTempDir(async (dir) => {
      const result = await checkBareEngines(dir, { network: false })
      assert.equal(result.status, 'skip')
    })
  })
})
