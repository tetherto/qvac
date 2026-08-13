'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const test = require('node:test')
const { spawnSync } = require('node:child_process')

const packageRoot = path.resolve(__dirname, '..', '..')

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(entryPath) : [entryPath]
  })
}

function getGeneratedOutputs(root) {
  return walk(path.join(root, 'src'))
    .filter((filePath) => filePath.endsWith('.ts') && !filePath.endsWith('.d.ts'))
    .flatMap((filePath) => {
      const outputBase = path.relative(path.join(root, 'src'), filePath).slice(0, -3)
      return [`${outputBase}.js`, `${outputBase}.d.ts`]
    })
}

function copyPath(sourceRoot, destinationRoot, relativePath) {
  const sourcePath = path.join(sourceRoot, relativePath)
  const destinationPath = path.join(destinationRoot, relativePath)
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
  fs.cpSync(sourcePath, destinationPath, { recursive: true })
}

function prepareTemporaryPackage(temporaryPackage) {
  const generatedOutputs = getGeneratedOutputs(packageRoot)
  const requiredPaths = [
    'package.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'src',
    'scripts/check-generated.mjs',
    ...generatedOutputs
  ]
  requiredPaths.forEach((relativePath) => copyPath(packageRoot, temporaryPackage, relativePath))
  return generatedOutputs
}

function initializeRepository(directory) {
  for (const args of [['init'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`)
  }
}

function snapshotOutputs(root, outputPaths) {
  return new Map(
    outputPaths.map((outputPath) => [outputPath, fs.readFileSync(path.join(root, outputPath))])
  )
}

function assertOutputsUnchanged(root, snapshots) {
  for (const [outputPath, snapshot] of snapshots) {
    const outputFile = path.join(root, outputPath)
    assert.ok(fs.existsSync(outputFile), `${outputPath} must not be deleted`)
    assert.deepEqual(
      fs.readFileSync(outputFile),
      snapshot,
      `${outputPath} must remain byte-for-byte unchanged`
    )
  }
}

test('build config pins generated files to LF line endings', () => {
  const config = JSON.parse(fs.readFileSync(path.join(packageRoot, 'tsconfig.build.json'), 'utf8'))
  assert.equal(config.compilerOptions.newLine, 'lf')
})

test('a failed generated-artifact check preserves committed outputs', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-ggml-failed-build-'))
  const temporaryPackage = path.join(temporaryRoot, 'asr-ggml')

  try {
    const generatedOutputs = prepareTemporaryPackage(temporaryPackage)
    fs.symlinkSync(
      path.join(packageRoot, 'node_modules'),
      path.join(temporaryPackage, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    initializeRepository(temporaryPackage)

    const snapshots = snapshotOutputs(temporaryPackage, generatedOutputs)
    const configPath = path.join(temporaryPackage, 'tsconfig.build.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    config.compilerOptions.noEmitOnError = true
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    fs.appendFileSync(
      path.join(temporaryPackage, 'src', 'index.ts'),
      '\nconst generatedArtifactBuildFailure: string = 42;\n'
    )

    const result = spawnSync(
      process.execPath,
      [path.join(temporaryPackage, 'scripts', 'check-generated.mjs')],
      { cwd: temporaryPackage, encoding: 'utf8' }
    )
    assert.notEqual(result.status, 0)
    assertOutputsUnchanged(temporaryPackage, snapshots)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
