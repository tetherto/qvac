import { createHash } from 'node:crypto'

import { classifySourceFile } from './files.js'
import { collectGitHistory } from './git-history.js'
import { buildHotspots, type Hotspot } from './hotspots.js'
import type {
  AuditedAnalysisResult,
  AuditedFinding,
  BaselineEntry,
  Finding,
  FindingChange,
} from './model.js'
import { renderJson } from './report.js'
import type {
  TriageCandidate,
  TriageFindingChange,
  TriageLifecycle,
  TriageReport,
} from './triage-model.js'

export interface BuildTriageReportOptions {
  readonly audit: AuditedAnalysisResult
  readonly root: string
  readonly now?: Date
  readonly historyWindowDays?: number
}

export async function buildTriageReport(
  options: BuildTriageReportOptions,
): Promise<TriageReport> {
  const resolved = options.audit.resolved.map(resolvedFinding)
  const allFindings = [...options.audit.findings, ...resolved]
  const hotspots = buildHotspots(allFindings)
  const paths = [...new Set(hotspots.flatMap(hotspotPaths))]
  const history = await collectGitHistory({
    root: options.root,
    paths,
    now: options.now ?? new Date(),
    windowDays: options.historyWindowDays ?? 180,
  })
  const historyByPath = new Map(history.map((item) => [item.path, item]))
  const findingByFingerprint = new Map(
    allFindings.map((finding) => [finding.fingerprint, finding]),
  )
  const changed = new Set(options.audit.changes.map(({ fingerprint }) => fingerprint))
  const changesByFingerprint = new Map(
    options.audit.changes.map((change) => [change.fingerprint, change]),
  )
  const resolvedFingerprints = new Set(
    options.audit.resolved.map(({ fingerprint }) => fingerprint),
  )
  const candidates = hotspots.map((hotspot): TriageCandidate => {
    const findings = hotspot.fingerprints.flatMap((fingerprint) => {
      const finding = findingByFingerprint.get(fingerprint)
      return finding === undefined ? [] : [finding]
    })
    const activeFindings = findings.filter(({ fingerprint }) => {
      return !resolvedFingerprints.has(fingerprint)
    })
    const changes = hotspot.fingerprints.flatMap((fingerprint) => {
      const change = changesByFingerprint.get(fingerprint)
      return change === undefined ? [] : [triageChange(change)]
    })
    return {
      id: hotspot.id,
      hotspot,
      lifecycle: lifecycleCounts(
        findings,
        changed,
        resolvedFingerprints,
      ),
      severityCounts: {
        high: activeFindings.filter(({ finding }) => finding.severity === 'high').length,
        advisory: activeFindings.filter(({ finding }) => {
          return finding.severity === 'advisory'
        }).length,
      },
      activeFindingCount: activeFindings.length,
      activeSeverity: activeSeverity(activeFindings),
      findingEvidence: findings
        .map((finding) => findingEvidence(
          finding,
          changed,
          resolvedFingerprints,
        ))
        .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint, 'en')),
      changes,
      sourceProfile: sourceProfile(hotspotPaths(hotspot)),
      maxThresholdRatio: maximumThresholdRatio(activeFindings),
      git: hotspotPaths(hotspot).flatMap((path) => {
        const item = historyByPath.get(path)
        return item === undefined ? [] : [item]
      }),
    }
  })

  return {
    schemaVersion: 1,
    sourceReportHash: sourceReportHash(options.audit),
    resolutionStatus: options.audit.resolutionStatus,
    candidates,
  }
}

function findingEvidence(
  audited: AuditedFinding,
  changed: ReadonlySet<string>,
  resolved: ReadonlySet<string>,
): TriageCandidate['findingEvidence'][number] {
  const lifecycle = resolved.has(audited.fingerprint)
    ? 'resolved' as const
    : audited.status === 'new'
      ? 'new' as const
      : changed.has(audited.fingerprint)
        ? 'changed' as const
        : 'existing' as const
  return {
    fingerprint: audited.fingerprint,
    lifecycle,
    severity: audited.finding.severity,
    ...(audited.finding.measurement === undefined
      ? {}
      : { measurement: audited.finding.measurement }),
  }
}

function activeSeverity(
  findings: readonly AuditedFinding[],
): TriageCandidate['activeSeverity'] {
  if (findings.length === 0) {
    return null
  }
  return findings.some(({ finding }) => finding.severity === 'high')
    ? 'high'
    : 'advisory'
}

function triageChange(change: FindingChange): TriageFindingChange {
  const directions = [
    severityDirection(change),
    measurementDirection(change),
  ].filter((direction): direction is 'worsened' | 'improved' => {
    return direction !== undefined
  })
  const direction = directions.length === 0 || new Set(directions).size > 1
    ? 'mixed' as const
    : directions[0] ?? 'mixed'

  return { ...change, direction }
}

function severityDirection(
  change: FindingChange,
): 'worsened' | 'improved' | undefined {
  if (change.severity === undefined) {
    return undefined
  }
  return change.severity.after === 'high' ? 'worsened' : 'improved'
}

function measurementDirection(
  change: FindingChange,
): 'worsened' | 'improved' | undefined {
  const { before, after } = change.measurement ?? {}
  if (before === null || after === null || before === undefined || after === undefined) {
    return undefined
  }
  if (before.unit !== after.unit || before.value === after.value) {
    return undefined
  }
  return after.value > before.value ? 'worsened' : 'improved'
}

function resolvedFinding(entry: BaselineEntry): AuditedFinding {
  const finding: Finding = {
    detector: entry.detector,
    rule: entry.rule,
    category: entry.category,
    severity: entry.severity,
    subject: entry.subject,
    summary: entry.summary,
    explanation: '',
    remediation: entry.remediation,
    primaryLocation: entry.primaryLocation,
    relatedLocations: entry.subject.kind === 'cycle'
      ? entry.subject.members.slice(1).map((path) => ({ path }))
      : [],
    ...(entry.measurement === undefined ? {} : { measurement: entry.measurement }),
  }
  return {
    fingerprint: entry.fingerprint,
    status: 'existing',
    finding,
  }
}

function lifecycleCounts(
  findings: readonly AuditedFinding[],
  changed: ReadonlySet<string>,
  resolved: ReadonlySet<string>,
): TriageLifecycle {
  const counts = {
    new: 0,
    changed: 0,
    existing: 0,
    resolved: 0,
  }

  for (const finding of findings) {
    if (resolved.has(finding.fingerprint)) {
      counts.resolved += 1
    } else if (finding.status === 'new') {
      counts.new += 1
    } else if (changed.has(finding.fingerprint)) {
      counts.changed += 1
    } else {
      counts.existing += 1
    }
  }
  return counts
}

function maximumThresholdRatio(
  findings: readonly AuditedFinding[],
): number | null {
  const ratios = findings.flatMap(({ finding }) => {
    const measurement = finding.measurement
    return measurement?.advisoryThreshold === undefined
      ? []
      : [measurement.value / measurement.advisoryThreshold]
  })
  if (ratios.length === 0) {
    return null
  }
  return Math.round(Math.max(...ratios) * 1000) / 1000
}

function sourceProfile(
  paths: readonly string[],
): TriageCandidate['sourceProfile'] {
  const profiles = new Set(paths.map(classifySourceFile))
  if (profiles.size > 1) {
    return 'mixed'
  }
  return profiles.has('auxiliary') ? 'auxiliary' : 'production'
}

function hotspotPaths(hotspot: Hotspot): readonly string[] {
  return hotspot.kind === 'file' ? [hotspot.path] : hotspot.paths
}

function sourceReportHash(audit: AuditedAnalysisResult): string {
  const digest = createHash('sha256')
    .update(renderJson(audit))
    .digest('hex')
  return `sha256:${digest}`
}
