import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertFabricCompatibility,
  inspectFabricCompatibility
} from '../scripts/check-addon-fabric-compatibility'

function writePackage(
  nodeModulesDir: string,
  name: string,
  manifest: Record<string, unknown>
): string {
  const packageDir = join(nodeModulesDir, ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, ...manifest }))
  return packageDir
}

function withFixture(run: (rootDir: string, nodeModulesDir: string) => void): void {
  const rootDir = mkdtempSync(join(tmpdir(), 'qvac-fabric-preflight-'))
  const nodeModulesDir = join(rootDir, 'node_modules')
  mkdirSync(nodeModulesDir, { recursive: true })
  try {
    run(rootDir, nodeModulesDir)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

test('aligned Fabric versions pass while legacy packages are reported', () => {
  withFixture((rootDir, nodeModulesDir) => {
    writePackage(nodeModulesDir, '@qvac/fabric', { version: '0.8.0', addon: true })
    writePackage(nodeModulesDir, '@qvac/embed-llamacpp', {
      addon: true,
      version: '0.36.0',
      dependencies: { '@qvac/fabric': '^0.8.0' }
    })
    writePackage(nodeModulesDir, '@qvac/classification-ggml', {
      addon: true,
      version: '0.22.0',
      dependencies: { '@qvac/fabric': '^0.8.0' }
    })
    writePackage(nodeModulesDir, '@qvac/legacy-addon', { addon: true, version: '0.1.0' })

    const report = inspectFabricCompatibility(rootDir)
    assert.deepEqual(report.versions, ['0.8.0'])
    assert.equal(report.consumers.length, 2)
    assert.equal(report.legacyAddons.length, 1)
    assert.doesNotThrow(() => assertFabricCompatibility(report))
    assert.throws(
      () => assertFabricCompatibility(report, { requireCompleteMetadata: true }),
      /metadata is incomplete/
    )
  })
})

test('nested incompatible Fabric versions fail the preflight', () => {
  withFixture((rootDir, nodeModulesDir) => {
    writePackage(nodeModulesDir, '@qvac/fabric', { version: '0.8.0', addon: true })
    const nestedNodeModulesDir = writePackage(nodeModulesDir, '@qvac/embed-llamacpp', {
      addon: true,
      version: '0.36.0',
      dependencies: { '@qvac/fabric': '^0.8.0' }
    })
    writePackage(join(nestedNodeModulesDir, 'node_modules'), '@qvac/fabric', {
      version: '0.7.0',
      addon: true
    })
    writePackage(nodeModulesDir, '@qvac/classification-ggml', {
      addon: true,
      version: '0.22.0',
      dependencies: { '@qvac/fabric': '^0.8.0' }
    })

    const report = inspectFabricCompatibility(rootDir)
    assert.deepEqual(report.versions, ['0.7.0', '0.8.0'])
    assert.throws(() => assertFabricCompatibility(report), /mixed @qvac\/fabric versions/)
  })
})

test('missing Fabric packages fail closed for migrated consumers', () => {
  withFixture((rootDir, nodeModulesDir) => {
    writePackage(nodeModulesDir, '@qvac/embed-llamacpp', {
      addon: true,
      version: '0.36.0',
      dependencies: { '@qvac/fabric': '^0.8.0' }
    })

    const report = inspectFabricCompatibility(rootDir)
    assert.equal(report.unresolvedConsumers.length, 1)
    assert.throws(() => assertFabricCompatibility(report), /could not resolve @qvac\/fabric/)
  })
})
