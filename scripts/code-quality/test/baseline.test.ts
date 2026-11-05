import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BaselineError,
  compareWithBaseline,
  createBaseline,
  parseBaseline,
} from '../baseline.js'
import { fingerprintFinding } from '../fingerprint.js'
import type { Finding } from '../model.js'

function finding(path: string, severity: Finding['severity'] = 'advisory'): Finding {
  return {
    detector: 'structure',
    rule: 'file-lines',
    category: 'size',
    severity,
    subject: { kind: 'file', path },
    summary: `${path} is long`,
    explanation: 'Long files are harder to navigate.',
    remediation: 'Split unrelated responsibilities.',
    primaryLocation: { path, line: 301, column: 1 },
    relatedLocations: [],
    measurement: {
      value: 301,
      unit: 'lines',
      advisoryThreshold: 300,
      highThreshold: 500,
    },
  }
}

test('baseline comparison classifies new, existing, and resolved debt', () => {
  const baseline = createBaseline([
    finding('packages/existing.ts'),
    finding('packages/resolved.ts', 'high'),
  ])

  const comparison = compareWithBaseline([
    finding('packages/new.ts', 'high'),
    finding('packages/existing.ts'),
  ], baseline)

  assert.deepEqual(
    comparison.findings.map(({ finding: current, status }) => [
      current.primaryLocation.path,
      status,
    ]),
    [
      ['packages/new.ts', 'new'],
      ['packages/existing.ts', 'existing'],
    ],
  )
  assert.deepEqual(
    comparison.resolved.map((entry) => entry.primaryLocation.path),
    ['packages/resolved.ts'],
  )
  assert.equal(comparison.resolutionStatus, 'complete')
  assert.deepEqual(comparison.changes, [])
})

test('baseline comparison reports measurement and severity drift separately', () => {
  const previous = finding('packages/growing.ts')
  const current: Finding = {
    ...previous,
    severity: 'high',
    measurement: {
      value: 700,
      unit: 'lines',
      advisoryThreshold: 300,
      highThreshold: 500,
    },
  }

  const comparison = compareWithBaseline(
    [current],
    createBaseline([previous]),
  )

  assert.equal(comparison.findings[0]?.status, 'existing')
  assert.deepEqual(comparison.changes, [
    {
      fingerprint: fingerprintFinding(current),
      detector: 'structure',
      rule: 'file-lines',
      subject: { kind: 'file', path: 'packages/growing.ts' },
      primaryLocation: {
        path: 'packages/growing.ts',
        line: 301,
        column: 1,
      },
      severity: {
        before: 'advisory',
        after: 'high',
      },
      measurement: {
        before: { value: 301, unit: 'lines' },
        after: { value: 700, unit: 'lines' },
      },
    },
  ])
})

test('baseline serialization order is stable regardless of finding order', () => {
  const first = createBaseline([
    finding('packages/z.ts'),
    finding('packages/a.ts'),
  ])
  const second = createBaseline([
    finding('packages/a.ts'),
    finding('packages/z.ts'),
  ])

  assert.deepEqual(first, second)
})

test('malformed baselines fail explicitly instead of becoming empty', () => {
  assert.throws(
    () => parseBaseline('{"schemaVersion":1,"findings":[{"fingerprint":7}]}'),
    BaselineError,
  )
  assert.throws(() => parseBaseline('not json'), BaselineError)
})
