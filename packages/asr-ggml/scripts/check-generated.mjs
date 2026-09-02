import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(packageRoot, 'src')
const handwrittenPaths = [
  'addon/',
  'benchmarks/',
  'binding.js',
  'build/',
  'examples/',
  'node_modules/',
  'prebuilds/',
  'scripts/',
  'src/',
  'test/'
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    ...options
  })

  if (result.error) throw result.error
  return result
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(entryPath) : [entryPath]
  })
}

function isHandwritten(filePath) {
  return handwrittenPaths.some(
    (handwrittenPath) => filePath === handwrittenPath || filePath.startsWith(handwrittenPath)
  )
}

const expectedOutputs = walk(sourceRoot)
  .filter((filePath) => filePath.endsWith('.ts') && !filePath.endsWith('.d.ts'))
  .flatMap((filePath) => {
    const sourcePath = path.relative(sourceRoot, filePath)
    const outputBase = sourcePath.slice(0, -'.ts'.length)
    return [`${outputBase}.js`, `${outputBase}.d.ts`]
  })
  .map((filePath) => filePath.split(path.sep).join('/'))

const trackedResult = run('git', ['ls-files', '--', '*.js', '*.d.ts'])
if (trackedResult.status !== 0) {
  process.stderr.write(trackedResult.stderr)
  process.exit(trackedResult.status ?? 1)
}

const trackedGeneratedOutputs = trackedResult.stdout
  .trim()
  .split('\n')
  .filter(Boolean)
  .filter((filePath) => !isHandwritten(filePath))

const trackedGeneratedOutputSet = new Set(trackedGeneratedOutputs)
const missingTrackedOutputs = expectedOutputs.filter(
  (outputPath) => !trackedGeneratedOutputSet.has(outputPath)
)
if (missingTrackedOutputs.length > 0) {
  process.stderr.write(
    `Generated asr-ggml files are not tracked:\n${missingTrackedOutputs.join('\n')}\n`
  )
  process.exit(1)
}

const expectedOutputSet = new Set(expectedOutputs)
const unexpectedTrackedOutputs = trackedGeneratedOutputs.filter(
  (outputPath) => !expectedOutputSet.has(outputPath)
)
if (unexpectedTrackedOutputs.length > 0) {
  process.stderr.write(
    `Tracked asr-ggml outputs have no TypeScript source:\n${unexpectedTrackedOutputs.join('\n')}\n`
  )
  process.exit(1)
}

function findChangedOutputs(temporaryRoot) {
  return expectedOutputs.filter((outputPath) => {
    const committedPath = path.join(packageRoot, outputPath)
    const generatedPath = path.join(temporaryRoot, outputPath)
    return (
      !fs.existsSync(committedPath) ||
      !fs.existsSync(generatedPath) ||
      !fs.readFileSync(committedPath).equals(fs.readFileSync(generatedPath))
    )
  })
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-ggml-generated-'))
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
let status = 1

try {
  const buildResult = run(npmCommand, ['run', 'build:ts', '--', '--outDir', temporaryRoot], {
    stdio: 'inherit'
  })
  if (buildResult.status !== 0) {
    status = buildResult.status ?? 1
  } else {
    const changedOutputs = findChangedOutputs(temporaryRoot)
    if (changedOutputs.length > 0) {
      process.stderr.write(
        `Generated asr-ggml files are out of date:\n${changedOutputs.join('\n')}\n`
      )
      status = 1
    } else {
      status = 0
    }
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}

if (status !== 0) process.exit(status)

console.log('Generated asr-ggml files are up to date.')
