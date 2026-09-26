import assert from 'node:assert/strict'
import test from 'node:test'

import { buildHotspots } from '../hotspots.js'
import type { AuditedFinding, Finding, FindingSeverity } from '../model.js'

test('file hotspots combine structural and fan-out evidence by file', () => {
  const findings = [
    audited(fileFinding('structure', 'file-lines', 'src/consumer-wrapper.tsx', 'high')),
    audited(functionFinding('function-lines', 'src/consumer-wrapper.tsx', 'render#1')),
    audited(functionFinding('modified-complexity', 'src/consumer-wrapper.tsx', 'render#1')),
    audited(fileFinding('dependencies', 'local-fan-out', 'src/consumer-wrapper.tsx')),
    audited(fileFinding('structure', 'file-lines', 'src/other.ts')),
  ]

  const hotspots = buildHotspots(findings)
  const wrapper = hotspots.find((hotspot) => {
    return hotspot.kind === 'file' && hotspot.path === 'src/consumer-wrapper.tsx'
  })

  assert.deepEqual(wrapper, {
    id: wrapper?.id,
    kind: 'file',
    severity: 'high',
    findingCount: 4,
    rules: [
      'dependencies/local-fan-out',
      'structure/file-lines',
      'structure/function-lines',
      'structure/modified-complexity',
    ],
    fingerprints: [
      'quality-v1:dependencies-local-fan-out-src/consumer-wrapper.tsx',
      'quality-v1:structure-file-lines-src/consumer-wrapper.tsx',
      'quality-v1:structure-function-lines-src/consumer-wrapper.tsx-render#1',
      'quality-v1:structure-modified-complexity-src/consumer-wrapper.tsx-render#1',
    ],
    path: 'src/consumer-wrapper.tsx',
    symbols: ['render#1'],
  })
  assert.match(wrapper?.id ?? '', /^hotspot-v1:[a-f0-9]{64}$/)
})

test('cycle hotspots merge paths connected by shared modules', () => {
  const findings = [
    audited(cycleFinding('runtime-cycle', ['src/a.ts', 'src/b.ts'], 'high')),
    audited(cycleFinding('runtime-cycle', ['src/b.ts', 'src/c.ts'], 'high')),
    audited(cycleFinding('type-only-cycle', ['src/c.ts', 'src/d.ts'])),
    audited(cycleFinding('type-only-cycle', ['src/x.ts', 'src/y.ts'])),
  ]

  const hotspots = buildHotspots(findings)
  const cycles = hotspots.filter((hotspot) => hotspot.kind === 'cycle')

  assert.equal(cycles.length, 2)
  assert.deepEqual(cycles[0], {
    id: cycles[0]?.id,
    kind: 'cycle',
    severity: 'high',
    findingCount: 3,
    rules: ['dependencies/runtime-cycle', 'dependencies/type-only-cycle'],
    fingerprints: [
      'quality-v1:dependencies-runtime-cycle-src/a.ts-src/b.ts',
      'quality-v1:dependencies-runtime-cycle-src/b.ts-src/c.ts',
      'quality-v1:dependencies-type-only-cycle-src/c.ts-src/d.ts',
    ],
    members: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
    paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
    hubModules: ['src/b.ts', 'src/c.ts', 'src/a.ts'],
    runtimeCycleCount: 2,
    compileTimeCycleCount: 1,
  })
  assert.deepEqual(cycles[1], {
    id: cycles[1]?.id,
    kind: 'cycle',
    severity: 'advisory',
    findingCount: 1,
    rules: ['dependencies/type-only-cycle'],
    fingerprints: ['quality-v1:dependencies-type-only-cycle-src/x.ts-src/y.ts'],
    members: ['src/x.ts', 'src/y.ts'],
    paths: ['src/x.ts', 'src/y.ts'],
    hubModules: ['src/x.ts', 'src/y.ts'],
    runtimeCycleCount: 0,
    compileTimeCycleCount: 1,
  })
})

test('cycle hotspots retain repository paths when members are package names', () => {
  const finding = cycleFinding('runtime-cycle', ['@qvac/sdk', '@qvac/inference'], 'high')
  const hotspot = buildHotspots([
    audited({
      ...finding,
      primaryLocation: { path: 'packages/sdk/package.json' },
      relatedLocations: [{ path: 'packages/inference/package.json' }],
    }),
  ])[0]

  assert.equal(hotspot?.kind, 'cycle')
  if (hotspot?.kind !== 'cycle') return
  assert.deepEqual(hotspot.members, ['@qvac/inference', '@qvac/sdk'])
  assert.deepEqual(hotspot.paths, [
    'packages/inference/package.json',
    'packages/sdk/package.json',
  ])
})

test('hotspot order is deterministic and prioritizes severity then overlap', () => {
  const low = audited(fileFinding('structure', 'file-lines', 'src/a.ts'))
  const high = audited(fileFinding('structure', 'file-lines', 'src/z.ts', 'high'))
  const overlapping = [
    audited(functionFinding('function-lines', 'src/b.ts', 'first#1')),
    audited(functionFinding('modified-complexity', 'src/b.ts', 'first#1')),
  ]

  const first = buildHotspots([low, ...overlapping, high])
  const second = buildHotspots([high, ...[...overlapping].reverse(), low])

  assert.deepEqual(first, second)
  assert.deepEqual(
    first.map((hotspot) => hotspot.kind === 'file' ? hotspot.path : hotspot.members),
    ['src/z.ts', 'src/b.ts', 'src/a.ts'],
  )
})

function audited(finding: Finding): AuditedFinding {
  const subject = finding.subject.kind === 'cycle'
    ? finding.subject.members.join('-')
    : finding.subject.kind === 'function'
      ? `${finding.subject.path}-${finding.subject.symbol}`
      : finding.subject.path
  return {
    fingerprint: `quality-v1:${finding.detector}-${finding.rule}-${subject}`,
    status: 'existing',
    finding,
  }
}

function fileFinding(
  detector: string,
  rule: string,
  path: string,
  severity: FindingSeverity = 'advisory',
): Finding {
  return {
    detector,
    rule,
    category: detector === 'structure' ? 'size' : 'dependency',
    severity,
    subject: { kind: 'file', path },
    summary: `${path} finding`,
    explanation: 'Evidence.',
    remediation: 'Address it.',
    primaryLocation: { path },
    relatedLocations: [],
  }
}

function functionFinding(rule: string, path: string, symbol: string): Finding {
  return {
    ...fileFinding('structure', rule, path),
    category: rule === 'modified-complexity' ? 'complexity' : 'size',
    subject: { kind: 'function', path, symbol },
  }
}

function cycleFinding(
  rule: 'runtime-cycle' | 'type-only-cycle',
  members: readonly string[],
  severity: FindingSeverity = 'advisory',
): Finding {
  return {
    detector: 'dependencies',
    rule,
    category: 'dependency',
    severity,
    subject: { kind: 'cycle', members },
    summary: 'Cycle.',
    explanation: 'Evidence.',
    remediation: 'Break it.',
    primaryLocation: { path: members[0] ?? '' },
    relatedLocations: members.slice(1).map((path) => ({ path })),
  }
}
