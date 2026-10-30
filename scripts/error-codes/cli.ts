import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateCodeRanges } from '../../packages/error/src/code-ranges.js'
import { checkCodeSources, type CodeSource } from './check.js'

function isCodeSource(value: unknown): value is CodeSource {
  if (value === null || typeof value !== 'object') return false
  return (
    'owner' in value &&
    typeof value.owner === 'string' &&
    'file' in value &&
    typeof value.file === 'string' &&
    'symbols' in value &&
    Array.isArray(value.symbols) &&
    value.symbols.length > 0 &&
    value.symbols.every((symbol: unknown) => typeof symbol === 'string')
  )
}

function main(): void {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const registry: unknown = JSON.parse(
    readFileSync(resolve(root, 'packages/error/code-ranges.json'), 'utf8')
  )
  validateCodeRanges(registry)
  if (
    !('sources' in registry) ||
    !Array.isArray(registry.sources) ||
    !registry.sources.every(isCodeSource)
  ) {
    throw new Error('Invalid monorepo error code sources')
  }
  const paths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'packages', 'plugins'],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\0')
    .filter(
      (file) =>
        /\.(?:ts|js|mjs)$/.test(file) &&
        !file.endsWith('.d.ts') &&
        !/(?:^|\/)(?:node_modules|dist|test|tests|examples|benchmarks|docs|scripts)\//.test(file) &&
        existsSync(resolve(root, file))
    )
  const files = new Map(paths.map((file) => [file, readFileSync(resolve(root, file), 'utf8')]))
  checkCodeSources(registry, registry.sources, files)
  console.log(
    `Validated ${registry.allocations.length} error code allocations and ${registry.sources.length} source modules.`
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
