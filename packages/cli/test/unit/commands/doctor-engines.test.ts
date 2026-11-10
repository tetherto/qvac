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

/**
 * A bare-stow whose Bare Kit pins the check reads. bare-kit-kotlin 0.2.2 and
 * bare-kit-swift 2.2.0 run Bare 1.36.2, per the SDK's built-in tables.
 */
function writeBareStow(projectRoot: string, kotlin = '0.2.2', swift = '2.2.0'): string {
  const bareStowDir = path.join(projectRoot, 'bare-stow')
  const target = path.join(bareStowDir, 'lib', 'target', 'bare-kit.js')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(
    target,
    "const bareKitSwift = { url: 'https://github.com/holepunchto/bare-kit-swift', " +
      `from: '${swift}', products: ['BareKit'] }\n` +
      `const bareKitKotlin = { 'com.github.holepunchto.bare-kit-kotlin:bare-kit-kotlin': 'v${kotlin}' }\n`
  )
  return bareStowDir
}

function writeSidecar(projectRoot: string, bare: string): void {
  writePackage(projectRoot, 'node_modules/bare-sidecar', {
    name: 'bare-sidecar',
    version: '0.5.15'
  })
  fs.writeFileSync(
    path.join(projectRoot, 'node_modules', 'bare-sidecar', 'versions.json'),
    JSON.stringify({ bare })
  )
}

function writeProject(
  projectRoot: string,
  options: { phone: boolean; enginesBare?: string }
): void {
  writePackage(projectRoot, '.', { name: 'app', version: '1.0.0' })
  fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), '{}')
  if (options.phone) {
    writePackage(projectRoot, 'node_modules/react-native-bare-kit', {
      name: 'react-native-bare-kit',
      version: '0.17.1'
    })
  }
  writePackage(projectRoot, 'node_modules/bare-inspect', {
    name: 'bare-inspect',
    version: '3.1.10',
    dependencies: { 'bare-type': '^1.0.0' }
  })
  writePackage(projectRoot, 'node_modules/bare-type', {
    name: 'bare-type',
    version: '1.4.0',
    addon: true,
    engines: { bare: options.enginesBare ?? '>=1.40.0' }
  })
}

describe('checkBareEngines', () => {
  it('fails with override advice when Bare Kit runs an older Bare', async () => {
    await withTempDir(async (dir) => {
      writeProject(dir, { phone: true })
      const result = await checkBareEngines(dir, {
        network: false,
        bareStowDir: writeBareStow(dir)
      })
      assert.equal(result.status, 'fail')
      assert.equal(result.severity, 'required')
      assert.match(
        result.hint ?? '',
        /bare-type@1\.4\.0 requires bare >=1\.40\.0, runtime is 1\.36\.2 \(from bare-kit-kotlin/
      )
      assert.match(result.hint ?? '', /Override \(bare-type\)/)
      assert.match(result.hint ?? '', /bare-stow pins a Bare Kit with Bare 1\.40\.0 or newer/)
      assert.match(result.detail ?? '', /android-arm64: Bare 1\.36\.2/)
      assert.match(result.detail ?? '', /ios-arm64: Bare 1\.36\.2/)
    })
  })

  it('passes when the Bare Kit Bare satisfies every engines.bare', async () => {
    await withTempDir(async (dir) => {
      writeProject(dir, { phone: true, enginesBare: '>=1.32.0' })
      const result = await checkBareEngines(dir, {
        network: false,
        bareStowDir: writeBareStow(dir)
      })
      assert.equal(result.status, 'pass')
      assert.match(result.value ?? '', /android-arm64: Bare 1\.36\.2/)
      assert.match(result.value ?? '', /ios-arm64: Bare 1\.36\.2/)
    })
  })

  it('checks a desktop project against the Bare of its bare-sidecar', async () => {
    await withTempDir(async (dir) => {
      writeProject(dir, { phone: false })
      writeSidecar(dir, '1.36.2')
      const result = await checkBareEngines(dir, { network: false })
      assert.equal(result.status, 'fail')
      assert.equal(result.code, 'abi-mismatch')
      assert.match(
        result.hint ?? '',
        /bare-type@1\.4\.0 requires bare >=1\.40\.0, runtime is 1\.36\.2 \(from bare-sidecar/
      )
      assert.match(
        result.detail ?? '',
        new RegExp(`${process.platform}-${process.arch}: Bare 1\\.36\\.2`)
      )
    })
  })

  it('warns that a desktop project without bare-sidecar is not checked', async () => {
    await withTempDir(async (dir) => {
      writeProject(dir, { phone: false })
      const result = await checkBareEngines(dir, { network: false })
      assert.equal(result.status, 'warn')
      assert.equal(result.value, 'runtime version unknown, not checked')
    })
  })

  it('warns instead of passing when the Bare Kit Bare version is unknown', async () => {
    await withTempDir(async (dir) => {
      writeProject(dir, { phone: true, enginesBare: '>=1.32.0' })
      const result = await checkBareEngines(dir, {
        network: false,
        bareStowDir: writeBareStow(dir, '9.0.0')
      })
      assert.equal(result.status, 'warn')
      assert.match(result.hint ?? '', /engines\.bare not checked for android-arm64/)
      assert.doesNotMatch(result.hint ?? '', /ios-arm64/)
    })
  })

  it('reports progress before the node_modules scan', async () => {
    await withTempDir(async (dir) => {
      writeProject(dir, { phone: true, enginesBare: '>=1.32.0' })
      const progress: string[] = []
      await checkBareEngines(dir, {
        network: false,
        bareStowDir: writeBareStow(dir),
        onProgress: (m) => progress.push(m)
      })
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
