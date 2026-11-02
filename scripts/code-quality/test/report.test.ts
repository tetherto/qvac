import assert from 'node:assert/strict'
import test from 'node:test'

import { compareWithBaseline, createBaseline } from '../baseline.js'
import type {
  AnalysisResult,
  AuditedAnalysisResult,
  Finding,
} from '../model.js'
import { renderJson, renderMarkdown } from '../report.js'

function finding(
  path: string,
  severity: Finding['severity'],
  rule = 'file-lines',
): Finding {
  return {
    detector: 'structure',
    rule,
    category: 'size',
    severity,
    subject: { kind: 'file', path },
    summary: `${path} exceeds its ${rule} threshold`,
    explanation: 'This makes the code harder to understand safely.',
    remediation: 'Extract a cohesive responsibility.',
    primaryLocation: { path, line: 42, column: 1 },
    relatedLocations: [],
    measurement: {
      value: 520,
      unit: 'lines',
      advisoryThreshold: 300,
      highThreshold: 500,
    },
  }
}

function auditedResult(findings: readonly Finding[]): AuditedAnalysisResult {
  const analysis: AnalysisResult = {
    schemaVersion: 1,
    coverage: [
      {
        detector: 'structure',
        version: '10.11.0',
        filesAnalyzed: 3,
        unresolvedImportsExempted: 2,
      },
    ],
    findings,
    diagnostics: [],
  }
  const comparison = compareWithBaseline(
    findings,
    createBaseline([finding('packages/a.ts', 'advisory')]),
  )

  return {
    ...analysis,
    ...comparison,
  }
}

test('JSON output is byte-stable for equivalent unordered input', () => {
  const a = finding('packages/a.ts', 'high')
  const z = finding('packages/z.ts', 'advisory')

  assert.equal(
    renderJson(auditedResult([z, a])),
    renderJson(auditedResult([a, z])),
  )
})

test('Markdown is a current-state snapshot independent of the baseline', () => {
  const findings = [
    finding('packages/a.ts', 'advisory'),
    finding('packages/b.ts', 'advisory'),
    finding('packages/c.ts', 'high'),
  ]
  const withMixedStatuses = auditedResult(findings)
  const withEmptyBaseline: AuditedAnalysisResult = {
    ...withMixedStatuses,
    ...compareWithBaseline(findings, createBaseline([])),
  }
  const markdown = renderMarkdown(withMixedStatuses)

  assert.equal(markdown, renderMarkdown(withEmptyBaseline))
  assert.match(markdown, /\*\*3 current findings\*\* · \*\*1 high\*\* · \*\*2 advisory\*\*/)
  assert.match(markdown, /## Hotspots/)
  assert.match(
    markdown,
    /\| High \| File \| packages\/c\.ts \| 1 \| `structure\/file-lines` \|/,
  )
  assert.ok(
    markdown.indexOf('## Hotspots') < markdown.indexOf('## Findings by rule'),
  )
  assert.match(markdown, /## Findings by rule/)
  assert.match(markdown, /\| `structure\/file-lines` \| 1 \| 2 \| 3 \|/)
  assert.match(markdown, /## Current findings/)
  assert.match(markdown, /### `structure\/file-lines` \(3\)/)
  assert.match(markdown, /packages\/c\.ts:42/)
  assert.match(markdown, /Measured: 520 lines; advisory at 300; high at 500\./)
  assert.match(markdown, /\*\*Next action:\*\* Extract a cohesive responsibility\./)
  assert.match(markdown, /2 unresolved import exemptions/)
  assert.doesNotMatch(markdown, /\b(?:new|existing|resolved)\b/i)
  assert.doesNotMatch(markdown, /Users\/|\\Users\\/)
})

test('Markdown surfaces analysis errors before quality findings', () => {
  const result: AuditedAnalysisResult = {
    ...auditedResult([finding('packages/new.ts', 'advisory')]),
    diagnostics: [
      {
        detector: 'dependencies',
        code: 'unresolved-import',
        message: 'Cannot resolve ./missing.js',
        location: { path: 'packages/new.ts', line: 2, column: 1 },
      },
    ],
  }
  const markdown = renderMarkdown(result)

  assert.ok(
    markdown.indexOf('## Analysis errors') < markdown.indexOf('## Current findings'),
  )
  assert.match(markdown, /Cannot resolve \.\/missing\.js/)
})

test('compact current rows retain semantic function and cycle identity', () => {
  const cycle: Finding = {
    detector: 'dependencies',
    rule: 'runtime-cycle',
    category: 'dependency',
    severity: 'high',
    subject: {
      kind: 'cycle',
      members: ['src/a.ts', 'src/b.ts'],
    },
    summary: 'Runtime dependency cycle',
    explanation: 'Runtime cycles obscure initialization order.',
    remediation: 'Choose one dependency direction.',
    primaryLocation: { path: 'src/a.ts' },
    relatedLocations: [{ path: 'src/b.ts' }],
  }
  const callback = finding('src/callback.ts', 'advisory', 'function-lines')
  const functionFinding: Finding = {
    ...callback,
    subject: {
      kind: 'function',
      path: 'src/callback.ts',
      symbol: 'map callback#1',
    },
  }
  const findings = [cycle, functionFinding]
  const comparison = compareWithBaseline(findings, createBaseline(findings))
  const markdown = renderMarkdown({
    schemaVersion: 1,
    coverage: [],
    diagnostics: [],
    ...comparison,
  })

  assert.match(markdown, /src\/a\.ts → src\/b\.ts/)
  assert.match(
    markdown,
    /map callback#1 · Measured: 520 lines; advisory at 300; high at 500\./,
  )
})
