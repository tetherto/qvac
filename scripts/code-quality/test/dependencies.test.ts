import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { analyzeDependencies } from '../detectors/dependencies.js'

test('runtime cycles require every edge to exist at runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-dependencies-cycle-'))
  const sources: Readonly<Record<string, string>> = {
    'src/a.ts': "import { b } from './b.js'\nexport const a = b\n",
    'src/b.ts': "import { a } from './a.js'\nexport const b = a\n",
    'src/mixed-a.ts': "import { mixedB } from './mixed-b.js'\nexport const mixedA = mixedB\n",
    'src/mixed-b.ts': "import type { MixedA } from './mixed-a.js'\nexport const mixedB = 1\nexport type MixedB = MixedA\n",
    'src/type-a.ts': "import type { TypeB } from './type-b.js'\nexport type TypeA = { b: TypeB }\n",
    'src/type-b.ts': "import type { TypeA } from './type-a.js'\nexport type TypeB = { a: TypeA }\n",
  }
  await writeSources(root, sources)

  const result = await analyzeDependencies({
    root,
    files: Object.keys(sources),
  })

  const cycles = result.findings.filter(({ subject }) => subject.kind === 'cycle')
  assert.deepEqual(
    cycles.map(({ rule, severity, subject }) => [
      rule,
      severity,
      subject.kind === 'cycle' ? subject.members : [],
    ]),
    [
      ['runtime-cycle', 'high', ['src/a.ts', 'src/b.ts']],
      ['type-only-cycle', 'advisory', ['src/mixed-a.ts', 'src/mixed-b.ts']],
      ['type-only-cycle', 'advisory', ['src/type-a.ts', 'src/type-b.ts']],
    ],
  )
})

test('dependency analysis reports local fan-out with profile thresholds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-dependencies-fanout-'))
  const imports = Array.from({ length: 21 }, (_, index) => {
    return `import './target-${index}.js'`
  })
  const sources: Record<string, string> = {
    'src/hub.ts': `${imports.join('\n')}\n`,
  }
  for (let index = 0; index < 21; index += 1) {
    sources[`src/target-${index}.ts`] = `export const value${index} = ${index}\n`
  }
  await writeSources(root, sources)

  const result = await analyzeDependencies({
    root,
    files: Object.keys(sources),
  })
  const fanOut = result.findings.find(({ rule }) => rule === 'local-fan-out')

  assert.ok(fanOut)
  assert.equal(fanOut.measurement?.value, 21)
  assert.equal(fanOut.severity, 'advisory')
  assert.deepEqual(fanOut.subject, { kind: 'file', path: 'src/hub.ts' })
  assert.match(
    fanOut.explanation,
    /depends on many local modules/,
  )
  assert.doesNotMatch(
    fanOut.explanation,
    /affected by changes to this module/,
  )
})

test('unresolved imports are analysis errors, not quality findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-dependencies-unresolved-'))
  const sources = {
    'src/index.ts': "import { missing } from './missing.js'\nexport { missing }\n",
  }
  await writeSources(root, sources)

  const result = await analyzeDependencies({
    root,
    files: Object.keys(sources),
  })

  assert.equal(result.findings.length, 0)
  assert.deepEqual(
    result.diagnostics.map(({ code, location }) => [code, location?.path]),
    [['unresolved-import', 'src/index.ts']],
  )
})

test('nearest tsconfig aliases resolve while unavailable external packages are out of graph scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-dependencies-tsconfig-'))
  const sources = {
    'app/src/index.ts': "import { value } from '@/value'\nimport 'not-installed-here'\nexport { value }\n",
    'app/src/value.ts': 'export const value = 1\n',
  }
  await writeSources(root, sources)
  await writeFile(
    join(root, 'app/tsconfig.json'),
    `${JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { '@/*': ['src/*'] },
      },
    })}\n`,
  )

  const result = await analyzeDependencies({
    root,
    files: Object.keys(sources),
  })

  assert.deepEqual(result.diagnostics, [])
})

test('documented generated-module imports are exempted and counted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-dependencies-exemption-'))
  const sources = {
    'packages/asr-ggml/src/index.ts': "const binding = require('./binding')\nexport { binding }\n",
    'packages/asr-ggml/src/lib/error.ts': "import manifest from '../package.json'\nexport { manifest }\n",
  }
  await writeSources(root, sources)

  const result = await analyzeDependencies({
    root,
    files: Object.keys(sources),
  })

  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.coverage[0]?.unresolvedImportsExempted, 2)
})

async function writeSources(
  root: string,
  sources: Readonly<Record<string, string>>,
): Promise<void> {
  await Promise.all(Object.entries(sources).map(async ([path, source]) => {
    const directory = join(root, path.slice(0, path.lastIndexOf('/')))
    await mkdir(directory, { recursive: true })
    await writeFile(join(root, path), source)
  }))
}
