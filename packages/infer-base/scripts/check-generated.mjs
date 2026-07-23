import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const handwrittenPaths = ['node_modules/', 'scripts/', 'test/']

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

const sourceFiles = [
  path.join(packageRoot, 'index.ts'),
  ...walk(path.join(packageRoot, 'src'))
].filter((filePath) => filePath.endsWith('.ts') && !filePath.endsWith('.d.ts'))

const expectedOutputs = sourceFiles
  .flatMap((filePath) => {
    const sourcePath = path.relative(packageRoot, filePath)
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
if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1)
}

const untrackedResult = run('git', ['ls-files', '--others', '--', ...generatedOutputs])
if (untrackedResult.status !== 0) {
  process.stderr.write(untrackedResult.stderr)
  process.exit(untrackedResult.status ?? 1)
}

if (untrackedResult.stdout.trim()) {
  process.stderr.write(`Generated infer-base files are not tracked:\n${untrackedResult.stdout}`)
  process.exit(1)
}

const diffResult = run('git', ['diff', '--exit-code', '--', ...generatedOutputs], {
  stdio: 'inherit'
})
if (diffResult.status !== 0) {
  process.exit(diffResult.status ?? 1)
}

console.log('Generated infer-base files are up to date.')
