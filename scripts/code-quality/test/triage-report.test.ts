import assert from 'node:assert/strict'
import test from 'node:test'

import type { FileHotspot } from '../hotspots.js'
import type { TriageCandidate, TriageReport } from '../triage-model.js'
import {
  renderTriageJson,
  renderTriageMarkdown,
} from '../triage-report.js'

test('triage Markdown shows the first ten candidates while JSON retains all', () => {
  const report = triageReport(12)
  const markdown = renderTriageMarkdown(report)
  const json = JSON.parse(renderTriageJson(report)) as TriageReport

  assert.match(markdown, /# Code Quality Triage/)
  assert.match(markdown, /Showing 1–10 of 12 candidate groups/)
  assert.match(markdown, /src\/file-00\.ts/)
  assert.equal(markdown.match(/^## /gm)?.length, 10)
  assert.match(markdown, /_Next page: offset 10\._/)
  assert.equal(json.candidates.length, 12)
})

test('triage Markdown filters by lifecycle state and kind', () => {
  const report = triageReport(4)
  const markdown = renderTriageMarkdown(report, {
    kind: 'file',
    lifecycle: 'new',
    limit: 10,
    offset: 0,
  })

  assert.match(markdown, /src\/file-00\.ts/)
  assert.match(markdown, /src\/file-02\.ts/)
  assert.doesNotMatch(markdown, /src\/file-01\.ts/)
  assert.doesNotMatch(markdown, /src\/file-03\.ts/)
})

function triageReport(count: number): TriageReport {
  return {
    schemaVersion: 1,
    sourceReportHash: `sha256:${'a'.repeat(64)}`,
    resolutionStatus: 'complete',
    candidates: Array.from({ length: count }, (_, index) => candidate(index)),
  }
}

function candidate(index: number): TriageCandidate {
  const path = `src/file-${String(index).padStart(2, '0')}.ts`
  const hotspot: FileHotspot = {
    id: `hotspot-v1:${String(index).padStart(64, '0')}`,
    kind: 'file',
    severity: index === 0 ? 'high' : 'advisory',
    findingCount: index + 1,
    rules: ['structure/function-lines'],
    fingerprints: [`quality-v1:${index}`],
    path,
    symbols: ['run#1'],
  }
  return {
    id: hotspot.id,
    hotspot,
    lifecycle: {
      new: index % 2 === 0 ? 1 : 0,
      changed: 0,
      existing: index % 2 === 0 ? 0 : 1,
      resolved: 0,
    },
    severityCounts: {
      high: index === 0 ? 1 : 0,
      advisory: index === 0 ? 0 : 1,
    },
    activeFindingCount: 1,
    activeSeverity: index === 0 ? 'high' : 'advisory',
    findingEvidence: [
      {
        fingerprint: `quality-v1:${index}`,
        lifecycle: index % 2 === 0 ? 'new' : 'existing',
        severity: index === 0 ? 'high' : 'advisory',
      },
    ],
    changes: [],
    sourceProfile: 'production',
    maxThresholdRatio: 1.5,
    git: [{ path, commitCount: index, lastChanged: '2026-09-20' }],
  }
}
