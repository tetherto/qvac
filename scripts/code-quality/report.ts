import type {
  AnalysisDiagnostic,
  AuditedAnalysisResult,
  AuditedFinding,
  BaselineEntry,
  DetectorCoverage,
  Finding,
  FindingChange,
  FindingMeasurement,
  SourceLocation,
} from './model.js'
import { buildHotspots, type Hotspot } from './hotspots.js'

export function renderJson(result: AuditedAnalysisResult): string {
  const normalized: AuditedAnalysisResult = {
    schemaVersion: 1,
    coverage: [...result.coverage].sort(compareCoverage),
    diagnostics: [...result.diagnostics].sort(compareDiagnostics),
    findings: [...result.findings].sort(compareAuditedFindings),
    changes: [...result.changes].sort(compareFindingChanges),
    resolutionStatus: result.resolutionStatus,
    resolved: [...result.resolved].sort(compareBaselineEntries),
  }

  return `${JSON.stringify(normalized, undefined, 2)}\n`
}

export function renderMarkdown(result: AuditedAnalysisResult): string {
  const diagnostics = [...result.diagnostics].sort(compareDiagnostics)
  const findings = [...result.findings].sort(compareCurrentFindings)
  const lines = [
    '# Code Quality Audit',
    '',
    summaryLine(findings, diagnostics),
    '',
    ...renderCoverage(result.coverage),
    ...renderHotspots(findings),
    ...renderRuleSummary(findings),
    ...renderDiagnostics(diagnostics),
    ...renderCurrentFindings(findings),
  ]

  return `${lines.join('\n').trimEnd()}\n`
}

function renderHotspots(
  findings: readonly AuditedFinding[],
): readonly string[] {
  const hotspots = buildHotspots(findings)
  const visible = hotspots.slice(0, 10)
  const lines = [
    '## Hotspots',
    '',
    'Related current findings grouped for triage. Detailed evidence remains in the rule sections.',
    '',
  ]

  if (visible.length === 0) {
    return [...lines, '_None._', '']
  }

  lines.push(
    '| Severity | Kind | Area | Findings | Rules | Detail |',
    '| --- | --- | --- | ---: | --- | --- |',
  )
  for (const hotspot of visible) {
    lines.push(`${[
      `| ${hotspot.severity === 'high' ? 'High' : 'Advisory'}`,
      hotspot.kind === 'file' ? 'File' : 'Dependency cluster',
      escapeTable(hotspotArea(hotspot)),
      String(hotspot.findingCount),
      hotspot.rules.map((rule) => `\`${escapeTable(rule)}\``).join(', '),
      escapeTable(hotspotDetail(hotspot)),
    ].join(' | ')} |`)
  }
  if (hotspots.length > visible.length) {
    lines.push('', `_Showing ${visible.length} of ${hotspots.length} hotspots._`)
  }

  return [...lines, '']
}

function hotspotArea(hotspot: Hotspot): string {
  return hotspot.kind === 'file'
    ? hotspot.path
    : hotspot.hubModules.join(', ')
}

function hotspotDetail(hotspot: Hotspot): string {
  if (hotspot.kind === 'file') {
    return hotspot.symbols.length === 0
      ? 'File-level findings'
      : hotspot.symbols.join(', ')
  }

  return [
    `${hotspot.members.length} modules`,
    `${hotspot.runtimeCycleCount} runtime cycles`,
    `${hotspot.compileTimeCycleCount} compile-time cycles`,
  ].join(' · ')
}

function renderRuleSummary(
  findings: readonly AuditedFinding[],
): readonly string[] {
  const counts = new Map<string, {
    high: number
    advisory: number
  }>()
  const ensure = (key: string): {
    high: number
    advisory: number
  } => {
    const current = counts.get(key) ?? {
      high: 0,
      advisory: 0,
    }
    counts.set(key, current)
    return current
  }

  for (const audited of findings) {
    const key = `${audited.finding.detector}/${audited.finding.rule}`
    const current = ensure(key)
    if (audited.finding.severity === 'high') {
      current.high += 1
    } else {
      current.advisory += 1
    }
  }

  const lines = [
    '## Findings by rule',
    '',
    '| Rule | High | Advisory | Total |',
    '| --- | ---: | ---: | ---: |',
  ]
  for (const [rule, value] of [...counts.entries()].sort(([left], [right]) => {
    return left.localeCompare(right, 'en')
  })) {
    lines.push(
      `| \`${escapeTable(rule)}\` | ${value.high} | ${value.advisory} | ${value.high + value.advisory} |`,
    )
  }

  return [...lines, '']
}

function summaryLine(
  findings: readonly AuditedFinding[],
  diagnostics: readonly AnalysisDiagnostic[],
): string {
  const highCount = findings.filter(({ finding }) => {
    return finding.severity === 'high'
  }).length
  const advisoryCount = findings.length - highCount

  return [
    `**${formatCount(findings.length, 'current finding')}**`,
    `**${highCount} high**`,
    `**${advisoryCount} advisory**`,
    `**${formatCount(diagnostics.length, 'analysis error')}**`,
  ].join(' · ')
}

function renderCoverage(coverage: readonly DetectorCoverage[]): readonly string[] {
  const lines = ['## Coverage', '']

  if (coverage.length === 0) {
    return [...lines, '_No detectors ran._', '']
  }

  for (const item of [...coverage].sort(compareCoverage)) {
    const counts = [
      formatCount(item.filesAnalyzed, 'file'),
      formatCount(item.modulesAnalyzed, 'module'),
      formatCount(item.workspacesAnalyzed, 'workspace'),
      formatCount(item.unresolvedImportsExempted, 'unresolved import exemption'),
    ].filter((value): value is string => value !== undefined)
    const suffix = counts.length === 0 ? '' : ` — ${counts.join(', ')}`
    lines.push(`- **${item.detector}** ${item.version}${suffix}`)
  }

  return [...lines, '']
}

function renderDiagnostics(
  diagnostics: readonly AnalysisDiagnostic[],
): readonly string[] {
  const lines = ['## Analysis errors', '']

  if (diagnostics.length === 0) {
    return [...lines, '_None._', '']
  }

  for (const diagnostic of diagnostics) {
    const location = diagnostic.location === undefined
      ? ''
      : ` at ${formatLocation(diagnostic.location)}`
    lines.push(
      `- **${diagnostic.detector}/${diagnostic.code}**${location}: ${diagnostic.message}`,
    )
  }

  return [...lines, '']
}

function renderCurrentFindings(
  findings: readonly AuditedFinding[],
): readonly string[] {
  const lines = ['## Current findings', '']
  if (findings.length === 0) {
    return [...lines, '_None._', '']
  }

  const byRule = new Map<string, AuditedFinding[]>()
  for (const audited of findings) {
    const key = `${audited.finding.detector}/${audited.finding.rule}`
    const group = byRule.get(key) ?? []
    group.push(audited)
    byRule.set(key, group)
  }

  for (const [rule, group] of [...byRule.entries()].sort(([left], [right]) => {
    return left.localeCompare(right, 'en')
  })) {
    const guidance = group[0]?.finding
    if (guidance === undefined) {
      continue
    }
    lines.push(
      `### \`${rule}\` (${group.length})`,
      '',
      `${guidance.explanation} **Next action:** ${guidance.remediation}`,
      '',
      '| Severity | ID | Location | Detail |',
      '| --- | --- | --- | --- |',
    )
    for (const audited of [...group].sort(compareCurrentFindings)) {
      lines.push(`${[
        `| ${severityLabel(audited.finding)}`,
        `\`${shortFingerprint(audited.fingerprint)}\``,
        escapeTable(formatLocation(audited.finding.primaryLocation)),
        escapeTable(formatFindingDetail(audited.finding)),
      ].join(' | ')} |`)
    }
    lines.push('')
  }

  return [...lines, '']
}

function formatMeasurement(measurement: FindingMeasurement): string {
  const thresholds = [
    measurement.advisoryThreshold === undefined
      ? undefined
      : `advisory at ${measurement.advisoryThreshold}`,
    measurement.highThreshold === undefined
      ? undefined
      : `high at ${measurement.highThreshold}`,
  ].filter((value): value is string => value !== undefined)
  const suffix = thresholds.length === 0 ? '' : `; ${thresholds.join('; ')}`

  return `Measured: ${measurement.value} ${measurement.unit}${suffix}.`
}

function formatFindingDetail(finding: Finding): string {
  const measurement = finding.measurement === undefined
    ? undefined
    : formatMeasurement(finding.measurement)

  switch (finding.subject.kind) {
    case 'cycle':
      return finding.subject.members.join(' → ')
    case 'function':
      return measurement === undefined
        ? finding.subject.symbol
        : `${finding.subject.symbol} · ${measurement}`
    case 'file':
      return measurement ?? '—'
  }
}

function escapeTable(value: string): string {
  return value.replaceAll('|', '\\|')
}

function formatLocation(location: SourceLocation): string {
  if (location.line === undefined) {
    return location.path
  }
  if (location.column === undefined) {
    return `${location.path}:${location.line}`
  }
  return `${location.path}:${location.line}:${location.column}`
}

function formatCount(count: number | undefined, singular: string): string | undefined {
  if (count === undefined) {
    return undefined
  }
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function severityLabel(finding: Finding): string {
  return finding.severity === 'high' ? 'High' : 'Advisory'
}

function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice('quality-v1:'.length, 'quality-v1:'.length + 12)
}

function compareCoverage(left: DetectorCoverage, right: DetectorCoverage): number {
  return `${left.detector}\u0000${left.version}`.localeCompare(
    `${right.detector}\u0000${right.version}`,
    'en',
  )
}

function compareDiagnostics(
  left: AnalysisDiagnostic,
  right: AnalysisDiagnostic,
): number {
  return diagnosticSortKey(left).localeCompare(diagnosticSortKey(right), 'en')
}

function diagnosticSortKey(diagnostic: AnalysisDiagnostic): string {
  return [
    diagnostic.detector,
    diagnostic.code,
    diagnostic.location?.path ?? '',
    String(diagnostic.location?.line ?? 0).padStart(10, '0'),
    diagnostic.message,
  ].join('\u0000')
}

function compareAuditedFindings(left: AuditedFinding, right: AuditedFinding): number {
  return auditedSortKey(left).localeCompare(auditedSortKey(right), 'en')
}

function compareCurrentFindings(left: AuditedFinding, right: AuditedFinding): number {
  const severityRank = (finding: Finding): string => {
    return finding.severity === 'high' ? '0' : '1'
  }

  return [
    severityRank(left.finding),
    left.finding.primaryLocation.path,
    left.finding.detector,
    left.finding.rule,
    left.fingerprint,
  ].join('\u0000').localeCompare(
    [
      severityRank(right.finding),
      right.finding.primaryLocation.path,
      right.finding.detector,
      right.finding.rule,
      right.fingerprint,
    ].join('\u0000'),
    'en',
  )
}

function auditedSortKey(audited: AuditedFinding): string {
  const statusRank = audited.status === 'new' ? '0' : '1'
  const severityRank = audited.finding.severity === 'high' ? '0' : '1'

  return [
    statusRank,
    severityRank,
    audited.finding.primaryLocation.path,
    audited.finding.detector,
    audited.finding.rule,
    audited.fingerprint,
  ].join('\u0000')
}

function compareBaselineEntries(left: BaselineEntry, right: BaselineEntry): number {
  return [left.primaryLocation.path, left.detector, left.rule, left.fingerprint]
    .join('\u0000')
    .localeCompare(
      [right.primaryLocation.path, right.detector, right.rule, right.fingerprint]
        .join('\u0000'),
      'en',
    )
}

function compareFindingChanges(left: FindingChange, right: FindingChange): number {
  return left.fingerprint.localeCompare(right.fingerprint, 'en')
}
