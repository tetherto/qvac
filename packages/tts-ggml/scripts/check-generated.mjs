import fs from 'node:fs'
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

function run (command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    ...options
  })
  if (result.error) throw result.error
  return result
}

function walk (directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(entryPath) : [entryPath]
  })
}

function isHandwritten (filePath) {
  return handwrittenPaths.some(
    (handwrittenPath) =>
      filePath === handwrittenPath || filePath.startsWith(handwrittenPath)
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

for (const outputPath of generatedOutputs) {
  fs.rmSync(path.join(packageRoot, outputPath), { force: true })
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const buildResult = run(npmCommand, ['run', 'build:ts'], { stdio: 'inherit' })
if (buildResult.status !== 0) process.exit(buildResult.status ?? 1)

const statusResult = run('git', [
  'status',
  '--short',
  '--untracked-files=all',
  '--',
  ...generatedOutputs
])
if (statusResult.status !== 0) {
  process.stderr.write(statusResult.stderr)
  process.exit(statusResult.status ?? 1)
}

if (statusResult.stdout) {
  console.error('Generated wrapper files are stale or incomplete:')
  process.stderr.write(statusResult.stdout)
  console.error('Run `npm run build:ts` and commit the generated changes.')
  process.exit(1)
}

console.log('Generated wrapper files are up to date.')
