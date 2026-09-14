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
  'addon-unavailable.js',
  'binding.js',
  'build/',
  'examples/',
  'lib/',
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

const generatedOutputs = [...new Set([...expectedOutputs, ...trackedGeneratedOutputs])].sort()

function snapshotOutputs(snapshotRoot) {
  for (const outputPath of generatedOutputs) {
    const sourcePath = path.join(packageRoot, outputPath)
    if (!fs.existsSync(sourcePath)) continue
    const snapshotPath = path.join(snapshotRoot, outputPath)
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
    fs.copyFileSync(sourcePath, snapshotPath)
  }
}

function removeOutputs() {
  for (const outputPath of generatedOutputs) {
    fs.rmSync(path.join(packageRoot, outputPath), { force: true })
  }
}

function restoreOutputs(snapshotRoot) {
  for (const outputPath of generatedOutputs) {
    const generatedPath = path.join(packageRoot, outputPath)
    const snapshotPath = path.join(snapshotRoot, outputPath)
    fs.rmSync(generatedPath, { force: true })
    if (!fs.existsSync(snapshotPath)) continue
    fs.mkdirSync(path.dirname(generatedPath), { recursive: true })
    fs.copyFileSync(snapshotPath, generatedPath)
  }
}

function changedOutputs(snapshotRoot) {
  return generatedOutputs.filter((outputPath) => {
    const snapshotPath = path.join(snapshotRoot, outputPath)
    const generatedPath = path.join(packageRoot, outputPath)
    if (!fs.existsSync(snapshotPath) || !fs.existsSync(generatedPath)) return true
    return !fs.readFileSync(snapshotPath).equals(fs.readFileSync(generatedPath))
  })
}

function staleOutputs() {
  const expected = new Set(expectedOutputs)
  return trackedGeneratedOutputs.filter((outputPath) => !expected.has(outputPath))
}

const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-generated-'))
try {
  snapshotOutputs(snapshotRoot)
  removeOutputs()
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const buildResult = run(npmCommand, ['run', 'build:ts'], { stdio: 'inherit' })
  if (buildResult.status !== 0) {
    process.exitCode = buildResult.status ?? 1
  } else {
    const changed = changedOutputs(snapshotRoot)
    const stale = staleOutputs()
    if (changed.length > 0 || stale.length > 0) {
      console.error('Generated wrapper files are stale or incomplete:')
      for (const outputPath of [...new Set([...changed, ...stale])].sort()) {
        console.error(`  ${outputPath}`)
      }
      console.error('Run `npm run build:ts` and include the generated changes.')
      process.exitCode = 1
    } else {
      console.log('Generated wrapper files are up to date.')
    }
  }
} finally {
  restoreOutputs(snapshotRoot)
  fs.rmSync(snapshotRoot, { recursive: true, force: true })
}
