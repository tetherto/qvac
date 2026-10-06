import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const testDir = join(__dirname, '..', 'test')

// test/dist is a build output, not a test source tree.
const SKIP_DIRS = new Set(['dist'])

function collectTestFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      files.push(...collectTestFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath)
    }
  }
  return files
}

const testFiles = collectTestFiles(testDir)

let hasFailure = false

function usesNodeTestRunner(filePath: string): boolean {
  const source = readFileSync(filePath, 'utf8')
  return source.includes("from 'node:test'") || source.includes('from "node:test"')
}

// Each file runs in its own Node process with tsx loaded, so TypeScript sources
// and the tsconfig path aliases resolve without a build step. brittle files run
// as plain scripts; node:test files go through Node's test runner.
for (const file of testFiles) {
  const args = usesNodeTestRunner(file)
    ? ['--import', 'tsx', '--test', file]
    : ['--import', 'tsx', file]
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    hasFailure = true
  }
}

process.exit(hasFailure ? 1 : 0)
