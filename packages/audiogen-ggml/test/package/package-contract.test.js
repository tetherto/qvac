'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const test = require('brittle')

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..')
const COMMAND_NAME = 'qvac-audiogen-download-models'
const DOWNLOADER_PATH = 'scripts/download-audiogen-ggml-models.js'
const ERROR_VERSION = '0.1.1'
const REGISTRY_CLIENT_VERSION = '^0.6.1'
const IS_WINDOWS = process.platform === 'win32'
const REQUIRED_PATHS = [
  'package/index.js',
  'package/index.d.ts',
  'package/audiogen.js',
  'package/audiogen.d.ts',
  'package/error.js',
  'package/error.d.ts',
  'package/scripts/download-audiogen-ggml-models.js'
]
const FORBIDDEN_PREFIXES = [
  'package/test/integration/',
  'package/test/mobile/',
  'package/test/utils/'
]

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function assertRequiredPaths(t, entries) {
  for (const requiredPath of REQUIRED_PATHS) {
    t.ok(entries.includes(requiredPath), `tarball includes ${requiredPath}`)
  }
}

function assertForbiddenPaths(t, entries) {
  for (const prefix of FORBIDDEN_PREFIXES) {
    t.absent(
      entries.some((entry) => entry.startsWith(prefix)),
      `tarball excludes ${prefix}`
    )
  }
}

function runDownloader(downloaderPath, cwd) {
  if (IS_WINDOWS) return run(process.execPath, [downloaderPath, '--help'], cwd)
  fs.accessSync(downloaderPath, fs.constants.X_OK)
  return run(downloaderPath, ['--help'], cwd)
}

function runDownloaderWithoutOutput(downloaderPath, cwd) {
  const command = IS_WINDOWS ? process.execPath : downloaderPath
  const args = IS_WINDOWS ? [downloaderPath] : []
  return spawnSync(command, args, { cwd, encoding: 'utf8' })
}

test('published package contains only consumer contract files', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-pack-'))
  t.teardown(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }))

  const packOutput = run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryDirectory],
    PACKAGE_ROOT
  )
  const [{ filename }] = JSON.parse(packOutput)
  const tarballPath = path.join(temporaryDirectory, filename)
  const entries = run('tar', ['-tzf', tarballPath], temporaryDirectory).trim().split('\n')

  assertRequiredPaths(t, entries)
  assertForbiddenPaths(t, entries)

  run('tar', ['-xzf', tarballPath], temporaryDirectory)
  const packedPackageRoot = path.join(temporaryDirectory, 'package')
  const packedPackage = JSON.parse(
    fs.readFileSync(path.join(packedPackageRoot, 'package.json'), 'utf8')
  )
  t.is(packedPackage.bin[COMMAND_NAME], DOWNLOADER_PATH, 'package exposes downloader bin')
  t.is(
    packedPackage.dependencies['@qvac/error'],
    ERROR_VERSION,
    'package pins the CommonJS-compatible error runtime'
  )
  t.is(
    packedPackage.dependencies['@qvac/registry-client'],
    REGISTRY_CLIENT_VERSION,
    'package ships the downloader runtime dependency'
  )
  const downloaderPath = path.join(packedPackageRoot, DOWNLOADER_PATH)
  const help = runDownloader(downloaderPath, packedPackageRoot)
  t.ok(help.includes(COMMAND_NAME), 'downloader help uses stable command')
  t.ok(help.includes('--output'), 'downloader help documents output')
  const missingOutput = runDownloaderWithoutOutput(downloaderPath, packedPackageRoot)
  t.is(missingOutput.status, 1, 'downloader rejects a missing output directory')
  t.ok(missingOutput.stderr.includes('--output is required'), 'downloader reports required output')
})
