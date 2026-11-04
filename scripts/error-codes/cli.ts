import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateCodeRanges } from '../../packages/error/src/code-ranges.js'
import { checkCodeSources, isCodeSourceFile } from './check.js'
import { sources } from './sources.js'

function main(): void {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const registry: unknown = JSON.parse(
    readFileSync(resolve(root, 'packages/error/code-ranges.json'), 'utf8')
  )
  validateCodeRanges(registry)
  const paths = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'packages', 'plugins'],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\0')
    .filter((file) => isCodeSourceFile(file) && existsSync(resolve(root, file)))
  const files = new Map(paths.map((file) => [file, readFileSync(resolve(root, file), 'utf8')]))
  checkCodeSources(registry, sources, files)
  console.log(
    `Validated ${registry.allocations.length} error code allocations and ${sources.length} source modules.`
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
