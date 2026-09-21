import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(entryPath) : [entryPath]
  })
}

const sourceFiles = [
  path.join(packageRoot, 'index.ts'),
  ...walk(path.join(packageRoot, 'src'))
].filter((filePath) => filePath.endsWith('.ts') && !filePath.endsWith('.d.ts'))

const generatedOutputs = sourceFiles.flatMap((filePath) => {
  const outputBase = path.relative(packageRoot, filePath).slice(0, -'.ts'.length)
  return [`${outputBase}.js`, `${outputBase}.d.ts`]
})

function assertLfOnly(root, outputPaths) {
  assert.ok(outputPaths.length > 0, 'there is at least one generated artifact to check')

  const offenders = outputPaths.filter((outputPath) =>
    fs.readFileSync(path.join(root, outputPath)).includes('\r\n')
  )
  assert.deepEqual(offenders, [], 'generated artifacts must use LF line endings')
}

test('build config pins the emitted line ending to lf', () => {
  const buildConfig = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'tsconfig.build.json'), 'utf8')
  )
  assert.equal(buildConfig.compilerOptions.newLine, 'lf')
})

test('committed generated artifacts use LF line endings', () => {
  assertLfOnly(packageRoot, generatedOutputs)
})

test('a fresh build emits LF line endings on any host platform', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-base-newline-'))

  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--project',
        path.join(packageRoot, 'tsconfig.build.json'),
        '--outDir',
        temporaryRoot
      ],
      { cwd: packageRoot, encoding: 'utf8' }
    )

    assert.equal(result.status, 0, `tsc failed:\n${result.stdout}${result.stderr}`)
    assertLfOnly(temporaryRoot, generatedOutputs)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('a failed generated-artifact check leaves committed outputs unchanged', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-base-failed-build-'))
  const temporaryPackage = path.join(temporaryRoot, 'infer-base')

  try {
    fs.cpSync(packageRoot, temporaryPackage, {
      recursive: true,
      filter(source) {
        return source !== path.join(packageRoot, 'node_modules')
      }
    })
    fs.symlinkSync(
      path.join(packageRoot, 'node_modules'),
      path.join(temporaryPackage, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    for (const args of [['init'], ['add', '.']]) {
      const result = spawnSync('git', args, {
        cwd: temporaryPackage,
        encoding: 'utf8'
      })
      assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`)
    }

    const snapshots = new Map(
      generatedOutputs.map((outputPath) => [
        outputPath,
        fs.readFileSync(path.join(temporaryPackage, outputPath))
      ])
    )

    const buildConfigPath = path.join(temporaryPackage, 'tsconfig.build.json')
    const buildConfig = JSON.parse(fs.readFileSync(buildConfigPath, 'utf8'))
    buildConfig.compilerOptions.noEmitOnError = true
    fs.writeFileSync(buildConfigPath, `${JSON.stringify(buildConfig, null, 2)}\n`)
    fs.appendFileSync(
      path.join(temporaryPackage, 'index.ts'),
      '\nconst generatedArtifactBuildFailure: string = 42;\n'
    )

    const result = spawnSync(
      process.execPath,
      [path.join(temporaryPackage, 'scripts', 'check-generated.mjs')],
      {
        cwd: temporaryPackage,
        encoding: 'utf8'
      }
    )
    assert.notEqual(result.status, 0, 'generated-artifact check must report the build failure')

    for (const [outputPath, snapshot] of snapshots) {
      const outputFile = path.join(temporaryPackage, outputPath)
      assert.ok(fs.existsSync(outputFile), `${outputPath} must not be deleted`)
      assert.deepEqual(
        fs.readFileSync(outputFile),
        snapshot,
        `${outputPath} must remain byte-for-byte unchanged`
      )
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
