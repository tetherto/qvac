import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const testDir = join(__dirname, '..', 'test')

// The Bare suite (test/bare) and its build output (test/dist) run via
// `test:bare`, so the Bun/Node unit runner skips them.
const SKIP_DIRS = new Set(['bare', 'dist'])

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

for (const file of testFiles) {
  const args = usesNodeTestRunner(file) ? ['test', file] : ['run', file]
  const result = spawnSync('bun', args, {
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    hasFailure = true
  }
}

process.exit(hasFailure ? 1 : 0)
