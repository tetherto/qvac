'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const test = require('brittle')

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..')
const COMMAND_NAME = 'qvac-audiogen-download-models'
const DOWNLOADER_PATH = 'scripts/download-audiogen-ggml-models.js'
const REPOSITORY_DOWNLOAD_COMMAND =
  'node scripts/download-audiogen-ggml-models.js --output ./models'
const IS_WINDOWS = process.platform === 'win32'
const NPM_COMMAND = IS_WINDOWS ? 'npm.cmd' : 'npm'
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

function runDownloaderWithoutRegistryClient(downloaderPath, cwd) {
  const outputPath = path.join(cwd, 'models')
  return spawnSync(process.execPath, [downloaderPath, '--output', outputPath], {
    cwd,
    encoding: 'utf8'
  })
}

test('published package contains only consumer contract files', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-pack-'))
  t.teardown(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }))

  const packOutput = run(
    NPM_COMMAND,
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
    packedPackage.scripts['download-models:registry'],
    REPOSITORY_DOWNLOAD_COMMAND,
    'repository downloader targets the integration model cache'
  )
  t.absent(
    packedPackage.dependencies['@qvac/registry-client'],
    'package does not install the optional downloader runtime for every consumer'
  )
  t.ok(
    packedPackage.peerDependenciesMeta['@qvac/registry-client'].optional,
    'package marks the downloader runtime as an optional peer'
  )
  const downloaderPath = path.join(packedPackageRoot, DOWNLOADER_PATH)
  const help = runDownloader(downloaderPath, packedPackageRoot)
  t.ok(help.includes(COMMAND_NAME), 'downloader help uses stable command')
  t.ok(help.includes('--output'), 'downloader help documents output')
  const missingOutput = runDownloaderWithoutOutput(downloaderPath, packedPackageRoot)
  t.is(missingOutput.status, 1, 'downloader rejects a missing output directory')
  t.ok(missingOutput.stderr.includes('--output is required'), 'downloader reports required output')
  const missingRegistryClient = runDownloaderWithoutRegistryClient(
    downloaderPath,
    packedPackageRoot
  )
  t.is(missingRegistryClient.status, 1, 'downloader rejects a missing optional registry client')
  t.ok(
    missingRegistryClient.stderr.includes('Install @qvac/registry-client'),
    'downloader explains how to install its optional runtime'
  )
})
