import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const resolver = join(sdkRoot, 'scripts', 'resolve-aliases.mjs')
const tsc = join(sdkRoot, 'node_modules', 'typescript', 'bin', 'tsc')

await test('writes NodeNext-compatible .js specifiers in declarations', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'qvac-resolve-aliases-'))
  const packageRoot = join(fixture, 'node_modules', '@qvac', 'sdk')

  try {
    mkdirSync(join(packageRoot, 'dist', 'models', 'registry'), { recursive: true })
    writeFileSync(
      join(packageRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          outDir: 'dist',
          paths: { '@/*': ['./*'] }
        }
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
      join(packageRoot, 'dist', 'models', 'registry', 'models.d.ts'),
      [
        'export declare const LLAMA_3_2_1B_INST_Q4_0: string',
        'export declare const GTE_LARGE_FP16: string',
        'export declare const BCI_EMBEDDER: string'
      ].join('\n')
    )
    writeFileSync(
      join(packageRoot, 'dist', 'models', 'registry', 'index.d.ts'),
      "export * from './models'\n"
    )
    writeFileSync(join(packageRoot, 'dist', 'index.d.ts'), "export * from '@/models/registry'\n")
    writeFileSync(
      join(packageRoot, 'dist', 'external-check.d.ts'),
      "export type { External } from '@scope/external/subpath'\n"
    )
    mkdirSync(join(packageRoot, 'dist', 'nested'))
    writeFileSync(
      join(packageRoot, 'dist', 'nested', 'types.d.ts'),
      [
        "export type { BCI_EMBEDDER } from '../models/registry/models'",
        "export type Model = typeof import('../models/registry/models').BCI_EMBEDDER"
      ].join('\n')
    )
    writeFileSync(join(packageRoot, 'dist', 'index.js'), "export * from './models/registry'\n")
    writeFileSync(
      join(packageRoot, 'dist', 'models', 'registry', 'index.js'),
      "export * from './models'\n"
    )
    writeFileSync(
      join(packageRoot, 'dist', 'models', 'registry', 'models.js'),
      [
        "export const LLAMA_3_2_1B_INST_Q4_0 = 'llama'",
        "export const GTE_LARGE_FP16 = 'gte'",
        "export const BCI_EMBEDDER = 'bci'"
      ].join('\n')
    )

    const result = spawnSync(process.execPath, [resolver], {
      cwd: packageRoot,
      encoding: 'utf8'
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      readFileSync(join(packageRoot, 'dist', 'index.d.ts'), 'utf8'),
      "export * from './models/registry/index.js'\n"
    )
    assert.equal(
      readFileSync(join(packageRoot, 'dist', 'models', 'registry', 'index.d.ts'), 'utf8'),
      "export * from './models.js'\n"
    )
    assert.equal(
      readFileSync(join(packageRoot, 'dist', 'external-check.d.ts'), 'utf8'),
      "export type { External } from '@scope/external/subpath'\n"
    )
    assert.equal(
      readFileSync(join(packageRoot, 'dist', 'nested', 'types.d.ts'), 'utf8'),
      [
        "export type { BCI_EMBEDDER } from '../models/registry/models.js'",
        "export type Model = typeof import('../models/registry/models.js').BCI_EMBEDDER"
      ].join('\n')
    )
    assert.equal(
      readFileSync(join(packageRoot, 'dist', 'index.js'), 'utf8'),
      "export * from './models/registry/index.js'\n"
    )

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
          strict: true
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
