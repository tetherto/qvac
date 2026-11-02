import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  writeRecurringTriageArtifacts,
  writeTriageArtifacts,
} from '../triage-cli.js'
import type { AuditedAnalysisResult, Finding } from '../model.js'

test('triage artifact writes are byte-identical for unchanged input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-triage-cli-'))
  const audit = auditResult([])

  const first = await writeTriageArtifacts({
    root,
    audit,
    now: new Date('2026-09-25T00:00:00Z'),
  })
  const firstJson = await readFile(first.jsonPath, 'utf8')
  const firstMarkdown = await readFile(first.markdownPath, 'utf8')
  const second = await writeTriageArtifacts({
    root,
    audit,
    now: new Date('2026-09-25T00:00:00Z'),
  })

  assert.equal(await readFile(second.jsonPath, 'utf8'), firstJson)
  assert.equal(await readFile(second.markdownPath, 'utf8'), firstMarkdown)
})

test('triage refuses an audit containing analysis errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-triage-error-'))
  const audit: AuditedAnalysisResult = {
    ...auditResult([]),
    diagnostics: [
      {
        detector: 'dependencies',
        code: 'detector-failure',
        message: 'synthetic failure',
      },
    ],
    resolutionStatus: 'withheld',
  }

  await assert.rejects(
    writeTriageArtifacts({
      root,
      audit,
      now: new Date('2026-09-25T00:00:00Z'),
    }),
    /Cannot triage 1 analysis error/,
  )
})

test('recurring triage tracks changes and resolutions since the previous successful run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-triage-recurring-'))
  const initial = finding(60)

  const first = await writeRecurringTriageArtifacts({
    root,
    audit: auditResult([initial]),
    now: new Date('2026-09-25T00:00:00Z'),
  })
  assert.equal(first.audit.findings[0]?.status, 'new')

  const worsened = finding(120)
  const second = await writeRecurringTriageArtifacts({
    root,
    audit: auditResult([worsened]),
    now: new Date('2026-09-26T00:00:00Z'),
  })
  assert.equal(second.audit.findings[0]?.status, 'existing')
  assert.deepEqual(second.audit.changes[0]?.measurement, {
    before: { value: 60, unit: 'code lines' },
    after: { value: 120, unit: 'code lines' },
  })

  const third = await writeRecurringTriageArtifacts({
    root,
    audit: auditResult([]),
    now: new Date('2026-09-27T00:00:00Z'),
  })
  assert.equal(third.audit.resolved.length, 1)
  assert.equal(third.audit.resolved[0]?.measurement?.value, 120)
})

test('a failed recurring triage does not advance the successful-run snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-triage-failed-run-'))
  await writeRecurringTriageArtifacts({
    root,
    audit: auditResult([finding(60)]),
    now: new Date('2026-09-25T00:00:00Z'),
  })

  await assert.rejects(
    writeRecurringTriageArtifacts({
      root,
      audit: {
        ...auditResult([finding(90)]),
        diagnostics: [{
          detector: 'structure',
          code: 'detector-failure',
          message: 'synthetic failure',
        }],
        resolutionStatus: 'withheld',
      },
      now: new Date('2026-09-26T00:00:00Z'),
    }),
    /Cannot triage 1 analysis error/,
  )

  const recovered = await writeRecurringTriageArtifacts({
    root,
    audit: auditResult([finding(90)]),
    now: new Date('2026-09-27T00:00:00Z'),
  })
  assert.deepEqual(recovered.audit.changes[0]?.measurement, {
    before: { value: 60, unit: 'code lines' },
    after: { value: 90, unit: 'code lines' },
  })
})

function auditResult(findings: readonly Finding[]): AuditedAnalysisResult {
  return {
    schemaVersion: 1,
    coverage: [],
    diagnostics: [],
    findings: findings.map((finding, index) => ({
      fingerprint: `quality-v1:${index}`,
      status: 'new',
      finding,
    })),
    changes: [],
    resolutionStatus: 'complete',
    resolved: [],
  }
}

function finding(value: number): Finding {
  return {
    detector: 'structure',
    rule: 'function-lines',
    category: 'size',
    severity: 'advisory',
    subject: {
      kind: 'function',
      path: 'src/example.ts',
      symbol: 'run#1',
    },
    summary: 'run has too many code lines',
    explanation: 'Large functions are harder to understand.',
    remediation: 'Extract a cohesive responsibility.',
    primaryLocation: { path: 'src/example.ts', line: 1 },
    relatedLocations: [],
    measurement: {
      value,
      unit: 'code lines',
      advisoryThreshold: 50,
      highThreshold: 100,
    },
  }
}
