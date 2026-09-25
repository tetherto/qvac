import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runAudit, type DetectorAdapter } from '../audit.js'
import { createBaseline } from '../baseline.js'
import type { AnalysisResult, Finding } from '../model.js'

test('audit writes byte-identical reports for identical results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-cli-deterministic-'))
  const detector = fixedDetector([finding('src/z.ts'), finding('src/a.ts', 'high')])
  const options = {
    root,
    command: 'audit' as const,
    detectors: [detector],
  }

  const first = await runAudit(options)
  const firstMarkdown = await readFile(join(root, '.quality/report.md'), 'utf8')
  const firstJson = await readFile(join(root, '.quality/report.json'), 'utf8')
  const second = await runAudit(options)

  assert.equal(first.exitCode, 0)
  assert.equal(second.exitCode, 0)
  assert.equal(
    await readFile(join(root, '.quality/report.md'), 'utf8'),
    firstMarkdown,
  )
  assert.equal(
    await readFile(join(root, '.quality/report.json'), 'utf8'),
    firstJson,
  )
})

test('a missing baseline is explicitly treated as empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-cli-missing-baseline-'))

  const result = await runAudit({
    root,
    command: 'audit',
    detectors: [fixedDetector([finding('src/new.ts')])],
  })

  assert.equal(result.result.findings[0]?.status, 'new')
  assert.equal(result.result.resolved.length, 0)
})

test('baseline command replaces the tracked snapshot and later shows resolved debt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-cli-baseline-'))
  const oldFinding = finding('src/old.ts')
  const newFinding = finding('src/new.ts')

  const baselineRun = await runAudit({
    root,
    command: 'baseline',
    detectors: [fixedDetector([oldFinding, newFinding])],
  })
  assert.equal(baselineRun.exitCode, 0)

  const auditRun = await runAudit({
    root,
    command: 'audit',
    detectors: [fixedDetector([newFinding])],
  })
  assert.equal(auditRun.result.findings[0]?.status, 'existing')
  assert.deepEqual(
    auditRun.result.resolved.map(({ primaryLocation }) => primaryLocation.path),
    ['src/old.ts'],
  )
})

test('detector failures produce analysis errors and never replace the baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-cli-detector-failure-'))
  const baselinePath = join(root, 'scripts/code-quality/baseline.json')
  await mkdir(join(root, 'scripts/code-quality'), { recursive: true })
  await writeFile(baselinePath, '{"sentinel":true}\n')
  const failingDetector: DetectorAdapter = {
    id: 'failing',
    analyze: () => Promise.reject(new Error('synthetic failure')),
  }

  const result = await runAudit({
    root,
    command: 'baseline',
    detectors: [failingDetector],
  })

  assert.equal(result.exitCode, 1)
  assert.equal(result.result.diagnostics[0]?.code, 'detector-failure')
  assert.equal(await readFile(baselinePath, 'utf8'), '{"sentinel":true}\n')
})

test('analysis errors withhold resolutions from the machine report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-cli-withheld-resolution-'))
  const baselinePath = join(root, 'scripts/code-quality/baseline.json')
  const omittedFinding = finding('src/omitted.ts', 'advisory', 'failing')
  await mkdir(join(root, 'scripts/code-quality'), { recursive: true })
  await writeFile(
    baselinePath,
    `${JSON.stringify(createBaseline([omittedFinding]), undefined, 2)}\n`,
  )

  const result = await runAudit({
    root,
    command: 'audit',
    detectors: [
      {
        id: 'failing',
        analyze: () => Promise.reject(new Error('synthetic failure')),
      },
    ],
  })

  assert.equal(result.exitCode, 1)
  assert.equal(result.result.resolutionStatus, 'withheld')
  assert.deepEqual(result.result.resolved, [])
  assert.match(
    await readFile(result.jsonPath, 'utf8'),
    /"resolutionStatus": "withheld"/,
  )
})

test('detector failure reports are stable across checkout roots', async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), 'quality-detector-root-a-'))
  const secondRoot = await mkdtemp(join(tmpdir(), 'quality-detector-root-b-'))
  const detector: DetectorAdapter = {
    id: 'failing',
    analyze: ({ root }) => {
      return Promise.reject(new Error(`Failure reading ${root}/src/input.ts`))
    },
  }

  const first = await runAudit({
    root: firstRoot,
    command: 'audit',
    detectors: [detector],
  })
  const second = await runAudit({
    root: secondRoot,
    command: 'audit',
    detectors: [detector],
  })

  assert.equal(
    await readFile(first.jsonPath, 'utf8'),
    await readFile(second.jsonPath, 'utf8'),
  )
  assert.equal(
    first.result.diagnostics[0]?.message,
    'Failure reading <repository>/src/input.ts',
  )
})

function fixedDetector(findings: readonly Finding[]): DetectorAdapter {
  return {
    id: 'fixed',
    analyze: async (): Promise<AnalysisResult> => ({
      schemaVersion: 1,
      coverage: [{ detector: 'fixed', version: '1', filesAnalyzed: 2 }],
      findings,
      diagnostics: [],
    }),
  }
}

function finding(
  path: string,
  severity: Finding['severity'] = 'advisory',
  detector = 'fixed',
): Finding {
  return {
    detector,
    rule: 'example',
    category: 'size',
    severity,
    subject: { kind: 'file', path },
    summary: `${path} needs attention`,
    explanation: 'Synthetic test debt.',
    remediation: 'Address the test finding.',
    primaryLocation: { path, line: 10, column: 1 },
    relatedLocations: [],
    measurement: {
      value: 11,
      unit: 'items',
      advisoryThreshold: 10,
      highThreshold: 20,
    },
  }
}
