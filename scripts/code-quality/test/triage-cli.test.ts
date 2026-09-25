import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { writeTriageArtifacts } from '../triage-cli.js'
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
