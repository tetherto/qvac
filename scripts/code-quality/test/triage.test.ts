import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { buildTriageReport } from '../triage.js'
import type {
  AuditedAnalysisResult,
  AuditedFinding,
  BaselineEntry,
  Finding,
} from '../model.js'

const execFileAsync = promisify(execFile)

test('triage candidates retain lifecycle, measurement, profile, and Git evidence', async () => {
  const root = await repositoryWithFile('src/hotspot.ts')
  const newFinding = audited(finding('file-lines', 'high', 700), 'new', 'new')
  const changedFinding = audited(
    functionFinding('modified-complexity', 'render#1', 30),
    'existing',
    'changed',
  )
  const resolved = baseline(finding('function-lines', 'advisory', 70), 'resolved')
  const audit: AuditedAnalysisResult = {
    schemaVersion: 1,
    coverage: [],
    diagnostics: [],
    findings: [changedFinding, newFinding],
    changes: [
      {
        fingerprint: changedFinding.fingerprint,
        detector: 'structure',
        rule: 'modified-complexity',
        subject: changedFinding.finding.subject,
        primaryLocation: changedFinding.finding.primaryLocation,
        measurement: {
          before: { value: 20, unit: 'branches' },
          after: { value: 30, unit: 'branches' },
        },
      },
    ],
    resolutionStatus: 'complete',
    resolved: [resolved],
  }

  const report = await buildTriageReport({
    audit,
    root,
    now: new Date('2026-09-25T00:00:00Z'),
  })

  assert.equal(report.schemaVersion, 1)
  assert.match(report.sourceReportHash, /^sha256:[a-f0-9]{64}$/)
  assert.equal(report.candidates.length, 1)
  assert.deepEqual(report.candidates[0], {
    id: report.candidates[0]?.id,
    hotspot: report.candidates[0]?.hotspot,
    lifecycle: {
      new: 1,
      changed: 1,
      existing: 0,
      resolved: 1,
    },
    severityCounts: { high: 1, advisory: 1 },
    activeFindingCount: 2,
    activeSeverity: 'high',
    findingEvidence: [
      {
        fingerprint: changedFinding.fingerprint,
        lifecycle: 'changed',
        severity: 'advisory',
        measurement: changedFinding.finding.measurement,
      },
      {
        fingerprint: newFinding.fingerprint,
        lifecycle: 'new',
        severity: 'high',
        measurement: newFinding.finding.measurement,
      },
      {
        fingerprint: resolved.fingerprint,
        lifecycle: 'resolved',
        severity: 'advisory',
        measurement: resolved.measurement,
      },
    ],
    changes: [
      {
        fingerprint: changedFinding.fingerprint,
        detector: 'structure',
        rule: 'modified-complexity',
        subject: changedFinding.finding.subject,
        primaryLocation: changedFinding.finding.primaryLocation,
        direction: 'worsened',
        measurement: {
          before: { value: 20, unit: 'branches' },
          after: { value: 30, unit: 'branches' },
        },
      },
    ],
    sourceProfile: 'production',
    maxThresholdRatio: 2.333,
    git: [
      {
        path: 'src/hotspot.ts',
        commitCount: 1,
        lastChanged: '2026-09-24',
      },
    ],
  })
})

test('resolved findings do not inflate an active candidate ranking', async () => {
  const root = await repositoryWithFile('src/hotspot.ts')
  const current = audited(functionFinding('function-lines', 'run#1', 60), 'existing', 'current')
  const resolved = baseline(finding('file-lines', 'high', 900), 'resolved')
  const report = await buildTriageReport({
    audit: {
      schemaVersion: 1,
      coverage: [],
      diagnostics: [],
      findings: [current],
      changes: [],
      resolutionStatus: 'complete',
      resolved: [resolved],
    },
    root,
    now: new Date('2026-09-25T00:00:00Z'),
  })

  assert.equal(report.candidates[0]?.activeFindingCount, 1)
  assert.equal(report.candidates[0]?.activeSeverity, 'advisory')
  assert.deepEqual(report.candidates[0]?.severityCounts, { high: 0, advisory: 1 })
  assert.equal(report.candidates[0]?.maxThresholdRatio, 0.2)
  assert.deepEqual(
    report.candidates[0]?.findingEvidence.map(({ lifecycle }) => lifecycle),
    ['existing', 'resolved'],
  )
})

test('triage output is stable for equivalent finding order', async () => {
  const root = await repositoryWithFile('src/hotspot.ts')
  const first = audited(finding('file-lines', 'high', 700), 'new', 'first')
  const second = audited(functionFinding('function-lines', 'run#1', 80), 'existing', 'second')
  const base = {
    schemaVersion: 1 as const,
    coverage: [],
    diagnostics: [],
    changes: [],
    resolutionStatus: 'complete' as const,
    resolved: [],
  }

  assert.deepEqual(
    await buildTriageReport({
      audit: { ...base, findings: [first, second] },
      root,
      now: new Date('2026-09-25T00:00:00Z'),
    }),
    await buildTriageReport({
      audit: { ...base, findings: [second, first] },
      root,
      now: new Date('2026-09-25T00:00:00Z'),
    }),
  )
})

function finding(
  rule: string,
  severity: Finding['severity'],
  value: number,
): Finding {
  return {
    detector: 'structure',
    rule,
    category: 'size',
    severity,
    subject: { kind: 'file', path: 'src/hotspot.ts' },
    summary: 'Hotspot finding.',
    explanation: 'Evidence.',
    remediation: 'Split responsibility.',
    primaryLocation: { path: 'src/hotspot.ts', line: 20 },
    relatedLocations: [],
    measurement: {
      value,
      unit: rule === 'modified-complexity' ? 'branches' : 'code lines',
      advisoryThreshold: rule === 'modified-complexity' ? 15 : 300,
      highThreshold: rule === 'modified-complexity' ? 25 : 500,
    },
  }
}

function functionFinding(rule: string, symbol: string, value: number): Finding {
  return {
    ...finding(rule, 'advisory', value),
    category: rule === 'modified-complexity' ? 'complexity' : 'size',
    subject: { kind: 'function', path: 'src/hotspot.ts', symbol },
  }
}

function audited(
  current: Finding,
  status: AuditedFinding['status'],
  id: string,
): AuditedFinding {
  return {
    fingerprint: `quality-v1:${id}`,
    status,
    finding: current,
  }
}

function baseline(current: Finding, id: string): BaselineEntry {
  return {
    fingerprint: `quality-v1:${id}`,
    detector: current.detector,
    rule: current.rule,
    category: current.category,
    severity: current.severity,
    subject: current.subject,
    summary: current.summary,
    remediation: current.remediation,
    primaryLocation: current.primaryLocation,
    ...(current.measurement === undefined ? {} : { measurement: current.measurement }),
  }
}

async function repositoryWithFile(path: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'quality-triage-'))
  await execFileAsync('git', ['init'], { cwd: root })
  await execFileAsync('git', ['config', 'user.email', 'quality@example.test'], {
    cwd: root,
  })
  await execFileAsync('git', ['config', 'user.name', 'Quality Test'], {
    cwd: root,
  })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, path), 'export const value = 1\n')
  await execFileAsync('git', ['add', '-A'], { cwd: root })
  await execFileAsync('git', ['commit', '-m', 'add hotspot'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-09-24T10:00:00Z',
      GIT_COMMITTER_DATE: '2026-09-24T10:00:00Z',
    },
  })
  return root
}
