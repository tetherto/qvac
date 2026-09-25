import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fingerprintFinding } from '../fingerprint.js'
import { analyzeStructure } from '../detectors/structure.js'

test('structure analysis reports exact file, function, complexity, and nesting measurements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-structure-'))
  const path = 'src/metrics.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, path), metricFixture())

  const result = await analyzeStructure({ root, files: [path] })
  const findings = new Map(
    result.findings.map((finding) => [finding.rule, finding]),
  )

  assert.equal(findings.get('file-lines')?.measurement?.value, 499)
  assert.equal(findings.get('file-lines')?.measurement?.unit, 'code lines')
  assert.equal(findings.get('function-lines')?.measurement?.value, 101)
  assert.equal(findings.get('function-lines')?.measurement?.unit, 'code lines')
  assert.equal(findings.get('modified-complexity')?.measurement?.value, 26)
  assert.equal(findings.get('nesting-depth')?.measurement?.value, 7)
  assert.equal(result.diagnostics.length, 0)
})

test('production and auxiliary files use different thresholds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-profiles-'))
  const productionPath = 'src/large.ts'
  const auxiliaryPath = 'test/large.test.ts'
  const source = `${Array.from({ length: 550 }, (_, index) => {
    return `const value${index} = ${index}`
  }).join('\n')}\n`
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'test'), { recursive: true })
  await writeFile(join(root, productionPath), source)
  await writeFile(join(root, auxiliaryPath), source)

  const result = await analyzeStructure({
    root,
    files: [auxiliaryPath, productionPath],
  })

  assert.deepEqual(
    result.findings
      .filter(({ rule }) => rule === 'file-lines')
      .map(({ primaryLocation }) => primaryLocation.path),
    [productionPath],
  )
})

test('size measurements exclude blank and comment-only lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-code-lines-'))
  const filePath = 'src/padded-file.ts'
  const functionPath = 'src/padded-function.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, filePath),
    [
      ...Array.from({ length: 299 }, (_, index) => `const value${index} = ${index}`),
      '// comment-only padding',
      '',
      '/* block-comment padding */',
    ].join('\n'),
  )
  await writeFile(
    join(root, functionPath),
    [
      'export function compact() {',
      ...Array.from({ length: 47 }, (_, index) => `  const value${index} = ${index}`),
      '  // comment-only padding',
      '',
      '  /* block-comment padding */',
      '}',
    ].join('\n'),
  )

  const result = await analyzeStructure({
    root,
    files: [filePath, functionPath],
  })

  assert.deepEqual(
    result.findings.filter(({ rule }) => {
      return rule === 'file-lines' || rule === 'function-lines'
    }),
    [],
  )
})

test('function fingerprints survive unrelated line insertions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-function-id-'))
  const path = 'src/handler.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  const longFunction = [
    'export function handleRequest() {',
    ...Array.from({ length: 99 }, (_, index) => `  const value${index} = ${index}`),
    '}',
    '',
  ].join('\n')
  await writeFile(join(root, path), longFunction)
  const before = await analyzeStructure({ root, files: [path] })
  await writeFile(join(root, path), `// inserted line\n\n${longFunction}`)
  const after = await analyzeStructure({ root, files: [path] })
  const beforeFinding = before.findings.find(({ rule }) => rule === 'function-lines')
  const afterFinding = after.findings.find(({ rule }) => rule === 'function-lines')

  assert.ok(beforeFinding)
  assert.ok(afterFinding)
  assert.equal(fingerprintFinding(beforeFinding), fingerprintFinding(afterFinding))
  assert.deepEqual(beforeFinding.subject, {
    kind: 'function',
    path,
    symbol: 'handleRequest#1',
  })
})

test('anonymous callback fingerprints use the callee name instead of a global ordinal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-callback-id-'))
  const path = 'src/callback.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  const callback = [
    'export const mapped = values.map((value) => {',
    ...Array.from({ length: 49 }, (_, index) => `  const value${index} = ${index}`),
    '  return value',
    '})',
    '',
  ].join('\n')
  await writeFile(join(root, path), `const values = [1]\n${callback}`)
  const before = await analyzeStructure({ root, files: [path] })
  await writeFile(
    join(root, path),
    `const values = [1]\nvalues.filter((value) => value > 0)\n${callback}`,
  )
  const after = await analyzeStructure({ root, files: [path] })
  const beforeFinding = before.findings.find(({ rule }) => rule === 'function-lines')
  const afterFinding = after.findings.find(({ rule }) => rule === 'function-lines')

  assert.ok(beforeFinding)
  assert.ok(afterFinding)
  assert.equal(fingerprintFinding(beforeFinding), fingerprintFinding(afterFinding))
  assert.deepEqual(beforeFinding.subject, {
    kind: 'function',
    path,
    symbol: 'mapped > map callback#1',
  })
})

test('callback fingerprints survive insertion of the same callee with another label', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-labeled-callback-id-'))
  const path = 'src/callbacks.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  const callback = (title: string, prefix: string): string => {
    return [
      `describe("${title}", () => {`,
      ...Array.from({ length: 55 }, (_, index) => {
        return `  const ${prefix}${index} = ${index}`
      }),
      '})',
    ].join('\n')
  }
  const original = [
    callback('first', 'firstValue'),
    callback('second', 'secondValue'),
  ].join('\n')
  await writeFile(join(root, path), original)
  const before = await analyzeStructure({ root, files: [path] })
  await writeFile(
    join(root, path),
    `describe("inserted", () => {})\n${original}`,
  )
  const after = await analyzeStructure({ root, files: [path] })
  const identities = (findings: typeof before.findings) => {
    return findings
      .filter(({ rule }) => rule === 'function-lines')
      .map((finding) => ({
        subject: finding.subject,
        fingerprint: fingerprintFinding(finding),
      }))
  }

  assert.deepEqual(identities(before.findings), identities(after.findings))
  assert.deepEqual(
    identities(before.findings).map(({ subject }) => subject),
    [
      {
        kind: 'function',
        path,
        symbol: 'describe "first" callback#1',
      },
      {
        kind: 'function',
        path,
        symbol: 'describe "second" callback#1',
      },
    ],
  )
})

test('callback identities include labeled enclosing scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-nested-callback-id-'))
  const path = 'src/nested-callbacks.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  const suite = (title: string, prefix: string): string => {
    return [
      `describe("${title}", () => {`,
      '  it("works", () => {',
      ...Array.from({ length: 55 }, (_, index) => {
        return `    const ${prefix}${index} = ${index}`
      }),
      '  })',
      '})',
    ].join('\n')
  }
  const original = [
    suite('suite-a', 'firstValue'),
    suite('suite-b', 'secondValue'),
  ].join('\n')
  await writeFile(join(root, path), original)
  const before = await analyzeStructure({ root, files: [path] })
  await writeFile(
    join(root, path),
    `describe("inserted", () => { it("works", () => {}) })\n${original}`,
  )
  const after = await analyzeStructure({ root, files: [path] })
  const nestedIdentities = (findings: typeof before.findings) => {
    return findings
      .filter((finding) => {
        return finding.rule === 'function-lines'
          && finding.subject.kind === 'function'
          && finding.subject.symbol.includes(' > it ')
      })
      .map((finding) => ({
        subject: finding.subject,
        fingerprint: fingerprintFinding(finding),
      }))
  }

  assert.deepEqual(
    nestedIdentities(before.findings),
    nestedIdentities(after.findings),
  )
  assert.deepEqual(
    nestedIdentities(before.findings).map(({ subject }) => subject),
    [
      {
        kind: 'function',
        path,
        symbol: 'describe "suite-a" callback#1 > it "works" callback#1',
      },
      {
        kind: 'function',
        path,
        symbol: 'describe "suite-b" callback#1 > it "works" callback#1',
      },
    ],
  )
})

test('unlabeled callback identities include their owning variable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-owned-callback-id-'))
  const path = 'src/owned-callbacks.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  const mapping = (owner: string, prefix: string): string => {
    return [
      `export const ${owner} = values.map((value) => {`,
      ...Array.from({ length: 55 }, (_, index) => {
        return `  const ${prefix}${index} = ${index}`
      }),
      '  return value',
      '})',
    ].join('\n')
  }
  const original = [
    'const values = [1]',
    mapping('first', 'firstValue'),
    mapping('second', 'secondValue'),
  ].join('\n')
  await writeFile(join(root, path), original)
  const before = await analyzeStructure({ root, files: [path] })
  await writeFile(
    join(root, path),
    `const inserted = [1].map((value) => value)\n${original}`,
  )
  const after = await analyzeStructure({ root, files: [path] })
  const identities = (findings: typeof before.findings) => {
    return findings
      .filter(({ rule }) => rule === 'function-lines')
      .map((finding) => ({
        subject: finding.subject,
        fingerprint: fingerprintFinding(finding),
      }))
  }

  assert.deepEqual(identities(before.findings), identities(after.findings))
  assert.deepEqual(
    identities(before.findings).map(({ subject }) => subject),
    [
      {
        kind: 'function',
        path,
        symbol: 'first > map callback#1',
      },
      {
        kind: 'function',
        path,
        symbol: 'second > map callback#1',
      },
    ],
  )
})

test('same-label callback identities include their owning variable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-owned-label-id-'))
  const path = 'src/owned-labels.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  const registration = (owner: string, prefix: string): string => {
    return [
      `export const ${owner} = emitter.on("data", () => {`,
      ...Array.from({ length: 55 }, (_, index) => {
        return `  const ${prefix}${index} = ${index}`
      }),
      '})',
    ].join('\n')
  }
  const original = [
    'declare const emitter: { on: (name: string, callback: () => void) => void }',
    registration('first', 'firstValue'),
    registration('second', 'secondValue'),
  ].join('\n')
  await writeFile(join(root, path), original)
  const before = await analyzeStructure({ root, files: [path] })
  await writeFile(
    join(root, path),
    `emitter.on("data", () => {})\n${original}`,
  )
  const after = await analyzeStructure({ root, files: [path] })
  const identities = (findings: typeof before.findings) => {
    return findings
      .filter(({ rule }) => rule === 'function-lines')
      .map((finding) => ({
        subject: finding.subject,
        fingerprint: fingerprintFinding(finding),
      }))
  }

  assert.deepEqual(identities(before.findings), identities(after.findings))
  assert.deepEqual(
    identities(before.findings).map(({ subject }) => subject),
    [
      {
        kind: 'function',
        path,
        symbol: 'first > on "data" callback#1',
      },
      {
        kind: 'function',
        path,
        symbol: 'second > on "data" callback#1',
      },
    ],
  )
})

test('same-named method identities include their owning class', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-method-id-'))
  const path = 'src/methods.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  const classWithMethod = (owner: string, prefix: string): string => {
    return [
      `export class ${owner} {`,
      '  process() {',
      ...Array.from({ length: 55 }, (_, index) => {
        return `    const ${prefix}${index} = ${index}`
      }),
      '  }',
      '}',
    ].join('\n')
  }
  const original = [
    classWithMethod('First', 'firstValue'),
    classWithMethod('Second', 'secondValue'),
  ].join('\n')
  await writeFile(join(root, path), original)
  const before = await analyzeStructure({ root, files: [path] })
  await writeFile(
    join(root, path),
    `class Inserted { process() {} }\n${original}`,
  )
  const after = await analyzeStructure({ root, files: [path] })
  const identities = (findings: typeof before.findings) => {
    return findings
      .filter(({ rule }) => rule === 'function-lines')
      .map((finding) => ({
        subject: finding.subject,
        fingerprint: fingerprintFinding(finding),
      }))
  }

  assert.deepEqual(identities(before.findings), identities(after.findings))
  assert.deepEqual(
    identities(before.findings).map(({ subject }) => subject),
    [
      {
        kind: 'function',
        path,
        symbol: 'First > process#1',
      },
      {
        kind: 'function',
        path,
        symbol: 'Second > process#1',
      },
    ],
  )
})

test('structure findings are deterministically sorted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-structure-sort-'))
  const paths = ['src/z.ts', 'src/a.ts']
  await mkdir(join(root, 'src'), { recursive: true })
  const source = `${Array.from({ length: 301 }, (_, index) => {
    return `const value${index} = ${index}`
  }).join('\n')}\n`
  await Promise.all(paths.map((path) => writeFile(join(root, path), source)))

  const result = await analyzeStructure({ root, files: paths })

  assert.deepEqual(
    result.findings.map(({ primaryLocation }) => primaryLocation.path),
    ['src/a.ts', 'src/z.ts'],
  )
})

test('unrelated eslint-disable comments are not parse errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-eslint-directive-'))
  const path = 'src/directive.ts'
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, path), '// eslint-disable-next-line no-console\nconsole.log("ok")\n')

  const result = await analyzeStructure({ root, files: [path] })

  assert.deepEqual(result.diagnostics, [])
})

function metricFixture(): string {
  const lines = [
    'export function longFunction() {',
    ...Array.from({ length: 99 }, (_, index) => `  const value${index} = ${index}`),
    '}',
    '',
    'export function complex(value: number) {',
    ...Array.from({ length: 25 }, (_, index) => `  if (value === ${index}) return ${index}`),
    '  return -1',
    '}',
    '',
    'export function nested() {',
    '  if (true) {',
    '    while (true) {',
    '      for (;;) {',
    '        if (true) {',
    '          while (true) {',
    '            for (;;) {',
    '              if (true) return true',
    '            }',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
  ]

  while (lines.length < 501) {
    lines.push(`const padding${lines.length} = ${lines.length}`)
  }

  return `${lines.join('\n')}\n`
}
