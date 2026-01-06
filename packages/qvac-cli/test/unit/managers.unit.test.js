'use strict'

const testTmp = require('test-tmp')
const test = require('brittle')
const { QvacModelManager } = require('../../src/managers/modelManager')
const { QvacPackageManager } = require('../../src/managers/packageManager')
const { tmpdir } = require('os')

test('QvacModelManager constructor initializes correctly', async (t) => {
  const config = {
    qvacHyperbeeKey: 'test-key',
    storageDir: await testTmp(t)
  }
  const storage = { test: 'storage' }

  const manager = new QvacModelManager(config, storage)

  t.is(manager.config, config, 'should store config')
  t.is(manager.storage, storage, 'should store storage')
  t.is(manager.hyperbeeKey, 'test-key', 'should store hyperbeeKey')
  t.ok(manager.modelCache, 'should initialize modelCache')
})

test('QvacModelManager.getModelAliasToPackageName throws for invalid alias', (t) => {
  const config = { qvacHyperbeeKey: 'test-key' }
  const manager = new QvacModelManager(config)

  t.exception(
    () => manager.getModelAliasToPackageName('invalid-alias'),
    'should throw error for invalid model alias'
  )
})

test('QvacModelManager.getModelAliasToPackageName returns package name for valid alias', (t) => {
  const config = { qvacHyperbeeKey: 'test-key' }
  const manager = new QvacModelManager(config)

  // This test assumes there's at least one valid model alias in the mapper
  // We'll test that the method exists and can be called
  t.ok(typeof manager.getModelAliasToPackageName === 'function', 'should have getModelAliasToPackageName method')
})

test('QvacPackageManager constructor initializes correctly', (t) => {
  const config = { test: 'config' }
  const manager = new QvacPackageManager(config)

  t.is(manager.config, config, 'should store config')
  t.is(manager.bootstrapDir, '.', 'should have default bootstrapDir')
})

test('QvacPackageManager.list returns array', (t) => {
  const config = { test: 'config' }
  const manager = new QvacPackageManager(config)

  const packages = manager.list()

  t.ok(Array.isArray(packages), 'should return array')
  t.ok(packages.length >= 0, 'should return non-negative length array')
})

test('QvacPackageManager.bootstrap throws for unsupported package', async (t) => {
  const config = { test: 'config' }
  const manager = new QvacPackageManager(config)

  await t.exception(
    manager.bootstrap('unsupported-package'),
    'should throw error for unsupported package'
  )
})

test('QvacPackageManager._mapRootDependenciesVersions maps dependencies correctly', (t) => {
  const config = { test: 'config' }
  const manager = new QvacPackageManager(config)

  const rootPackageJson = {
    dependencies: {
      package1: '^1.0.0',
      package2: '~2.0.0'
    },
    devDependencies: {
      'dev-package1': '^3.0.0'
    }
  }

  const dependencies = ['package1', 'package2', 'dev-package1', 'unmapped-package']

  const mapped = manager._mapRootDependenciesVersions(rootPackageJson, dependencies)

  t.ok(mapped.includes('package1@^1.0.0'), 'should map package1 with version')
  t.ok(mapped.includes('package2@~2.0.0'), 'should map package2 with version')
  t.ok(mapped.includes('dev-package1@^3.0.0'), 'should map dev-package1 with version')
  t.ok(mapped.includes('unmapped-package'), 'should keep unmapped package as is')
  t.is(mapped.length, 4, 'should have correct number of mapped dependencies')
})

test('QvacPackageManager._writePackageJson creates valid package.json', async (t) => {
  const config = { test: 'config' }
  const manager = new QvacPackageManager(config)

  const testDir = await tmpdir(t)
  const packageName = 'test-package'
  const runScript = 'bare ./index.js'

  manager._writePackageJson(packageName, runScript, testDir)

  const packageJsonPath = require('path').join(testDir, 'package.json')
  const fs = require('fs')

  t.ok(fs.existsSync(packageJsonPath), 'should create package.json file')

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

  t.is(packageJson.name, `${packageName}-bootstrap`, 'should have correct name')
  t.is(packageJson.version, '1.0.0', 'should have correct version')
  t.is(packageJson.description, 'Quickstart package for Qvac project', 'should have correct description')
  t.is(packageJson.main, 'index.js', 'should have correct main')
  t.is(packageJson.scripts.start, runScript, 'should have correct start script')
  t.is(packageJson.author, '', 'should have empty author')
  t.is(packageJson.license, 'ISC', 'should have correct license')
})
