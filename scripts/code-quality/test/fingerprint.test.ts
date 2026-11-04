import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canonicalDirectedCycle,
  fingerprintFinding,
} from '../fingerprint.js'
import type { Finding } from '../model.js'

function fileFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    detector: 'structure',
    rule: 'file-lines',
    category: 'size',
    severity: 'advisory',
    subject: { kind: 'file', path: 'packages/example/src/index.ts' },
    summary: 'File is long',
    explanation: 'Long files are harder to navigate.',
    remediation: 'Split unrelated responsibilities.',
    primaryLocation: {
      path: 'packages/example/src/index.ts',
      line: 301,
      column: 1,
    },
    relatedLocations: [],
    measurement: {
      value: 321,
      unit: 'lines',
      advisoryThreshold: 300,
      highThreshold: 500,
    },
    ...overrides,
  }
}

test('file fingerprints identify debt rather than mutable presentation', () => {
  const original = fileFinding()
  const changedPresentation = fileFinding({
    severity: 'high',
    summary: 'Reworded summary',
    explanation: 'Reworded explanation.',
    remediation: 'Different next action.',
    primaryLocation: {
      path: 'packages/example/src/index.ts',
      line: 999,
      column: 9,
    },
    measurement: {
      value: 700,
      unit: 'lines',
      advisoryThreshold: 250,
      highThreshold: 450,
    },
  })

  assert.equal(
    fingerprintFinding(original),
    fingerprintFinding(changedPresentation),
  )
  assert.match(fingerprintFinding(original), /^quality-v1:[a-f0-9]{64}$/)
})

test('function fingerprints include a stable symbol identity but not line numbers', () => {
  const functionFinding = fileFinding({
    rule: 'function-lines',
    subject: {
      kind: 'function',
      path: 'packages/example/src/index.ts',
      symbol: 'parseRequest#1',
    },
  })
  const movedFunction = {
    ...functionFinding,
    primaryLocation: {
      path: 'packages/example/src/index.ts',
      line: 800,
      column: 1,
    },
  }
  const differentFunction = {
    ...functionFinding,
    subject: {
      kind: 'function' as const,
      path: 'packages/example/src/index.ts',
      symbol: 'parseRequest#2',
    },
  }

  assert.equal(
    fingerprintFinding(functionFinding),
    fingerprintFinding(movedFunction),
  )
  assert.notEqual(
    fingerprintFinding(functionFinding),
    fingerprintFinding(differentFunction),
  )
})
test('directed cycle identity is rotation invariant but direction sensitive', () => {
  const cycle = ['packages/a/src/a.ts', 'packages/b/src/b.ts', 'packages/c/src/c.ts']
  const rotated = ['packages/b/src/b.ts', 'packages/c/src/c.ts', 'packages/a/src/a.ts']
  const reversed = ['packages/a/src/a.ts', 'packages/c/src/c.ts', 'packages/b/src/b.ts']

  assert.deepEqual(canonicalDirectedCycle(cycle), cycle)
  assert.deepEqual(canonicalDirectedCycle(rotated), cycle)

  const makeCycleFinding = (members: readonly string[]): Finding => fileFinding({
    detector: 'dependencies',
    rule: 'runtime-cycle',
    category: 'dependency',
    severity: 'high',
    subject: { kind: 'cycle', members },
  })

  assert.equal(
    fingerprintFinding(makeCycleFinding(cycle)),
    fingerprintFinding(makeCycleFinding(rotated)),
  )
  assert.notEqual(
    fingerprintFinding(makeCycleFinding(cycle)),
    fingerprintFinding(makeCycleFinding(reversed)),
  )
})
