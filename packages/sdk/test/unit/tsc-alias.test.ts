import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const tsc = join(sdkRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const tscAlias = join(sdkRoot, 'node_modules', '.bin', 'tsc-alias')

await test('tsc-alias emits NodeNext-compatible .js specifiers in declarations', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'qvac-tsc-alias-'))
  const packageRoot = join(fixture, 'node_modules', '@qvac', 'sdk')

  try {
    mkdirSync(join(packageRoot, 'src', 'models', 'registry'), { recursive: true })
    mkdirSync(join(packageRoot, 'src', 'nested'), { recursive: true })

    writeFileSync(
      join(packageRoot, 'tsconfig.json'),
      JSON.stringify({
        'tsc-alias': { resolveFullPaths: true },
        compilerOptions: {
          module: 'ES2022',
          moduleResolution: 'bundler',
          target: 'ES2022',
          declaration: true,
          rootDir: 'src',
          outDir: 'dist',
          baseUrl: 'src',
          paths: { '@/*': ['./*'] }
        },
        include: ['src/**/*']
      })
    )
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@qvac/sdk',
        type: 'module',
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          './models': {
            types: './dist/models/registry/index.d.ts',
            import: './dist/models/registry/index.js'
          }
        }
      })
    )
    writeFileSync(
      join(packageRoot, 'src', 'models', 'registry', 'models.ts'),
      [
        "export const LLAMA_3_2_1B_INST_Q4_0 = 'llama'",
        "export const GTE_LARGE_FP16 = 'gte'",
        "export const BCI_EMBEDDER = 'bci'"
      ].join('\n')
    )
    // Directory alias, so the rewrite has to resolve through to `/index.js`.
    writeFileSync(
      join(packageRoot, 'src', 'models', 'registry', 'index.ts'),
      "export * from './models'\n"
    )
    writeFileSync(join(packageRoot, 'src', 'index.ts'), "export * from '@/models/registry'\n")
    // Alias resolving to a parent-relative path, the `../schemas`-style case.
    writeFileSync(
      join(packageRoot, 'src', 'nested', 'types.ts'),
      "export type { BCI_EMBEDDER } from '@/models/registry/models'\n"
    )

    const compile = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
      cwd: packageRoot,
      encoding: 'utf8'
    })
    assert.equal(compile.status, 0, compile.stderr || compile.stdout)

    const alias = spawnSync(tscAlias, ['-p', 'tsconfig.json'], {
      cwd: packageRoot,
      encoding: 'utf8'
    })
    assert.equal(alias.status, 0, alias.stderr || alias.stdout)

    const read = (...p: string[]) => readFileSync(join(packageRoot, 'dist', ...p), 'utf8')

    // Declarations carry runtime .js specifiers; NodeNext resolves them back to
    // the sibling .d.ts.
    assert.match(read('index.d.ts'), /from '\.\/models\/registry\/index\.js'/)
    assert.match(read('nested', 'types.d.ts'), /from '\.\.\/models\/registry\/models\.js'/)
    assert.match(read('index.js'), /from '\.\/models\/registry\/index\.js'/)
    assert.doesNotMatch(read('index.d.ts'), /'@\//)

    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(
      join(fixture, 'consumer.ts'),
      [
        "import { BCI_EMBEDDER } from '@qvac/sdk'",
        "import { GTE_LARGE_FP16, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/sdk/models'",
        'void [BCI_EMBEDDER, GTE_LARGE_FP16, LLAMA_3_2_1B_INST_Q4_0]'
      ].join('\n')
    )
    writeFileSync(
      join(fixture, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          types: []
        },
        include: ['consumer.ts']
      })
    )

    const typecheck = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
      cwd: fixture,
      encoding: 'utf8'
    })
    assert.equal(typecheck.status, 0, typecheck.stderr || typecheck.stdout)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

await test('alias rewriting is limited to the internal "@/" alias', () => {
  const { config } = ts.readConfigFile(join(sdkRoot, 'tsconfig.alias.json'), (p) =>
    readFileSync(p, 'utf8')
  )

  assert.equal(config['tsc-alias']?.resolveFullPaths, true)
  // Rewriting the "@qvac/sdk" self-import would turn the package-name imports in
  // dist/examples (embedded verbatim in the docs) into relative paths, and would
  // bypass the exports map.
  assert.deepEqual(Object.keys(config.compilerOptions.paths), ['@/*'])
})
