import { createHash } from 'node:crypto'

import type {
  AuditedFinding,
  FindingSeverity,
} from './model.js'

interface HotspotBase {
  readonly id: string
  readonly severity: FindingSeverity
  readonly findingCount: number
  readonly rules: readonly string[]
  readonly fingerprints: readonly string[]
}

export interface FileHotspot extends HotspotBase {
  readonly kind: 'file'
  readonly path: string
  readonly symbols: readonly string[]
}

export interface CycleHotspot extends HotspotBase {
  readonly kind: 'cycle'
  readonly members: readonly string[]
  readonly paths: readonly string[]
  readonly hubModules: readonly string[]
  readonly runtimeCycleCount: number
  readonly compileTimeCycleCount: number
}

export type Hotspot = FileHotspot | CycleHotspot

export function buildHotspots(
  findings: readonly AuditedFinding[],
): readonly Hotspot[] {
  const fileFindings = new Map<string, AuditedFinding[]>()
  const cycleFindings: AuditedFinding[] = []

  for (const audited of findings) {
    const { subject } = audited.finding
    if (subject.kind === 'cycle') {
      cycleFindings.push(audited)
      continue
    }

    const group = fileFindings.get(subject.path) ?? []
    group.push(audited)
    fileFindings.set(subject.path, group)
  }

  return [
    ...[...fileFindings.entries()].map(([path, group]) => {
      return fileHotspot(path, group)
    }),
    ...cycleComponents(cycleFindings).map(cycleHotspot),
  ].sort(compareHotspots)
}

function fileHotspot(
  path: string,
  findings: readonly AuditedFinding[],
): FileHotspot {
  const symbols = findings.flatMap(({ finding }) => {
    return finding.subject.kind === 'function'
      ? [finding.subject.symbol]
      : []
  })

  return {
    ...sharedFields(findings),
    id: hotspotId({ kind: 'file', path }),
    kind: 'file',
    path,
    symbols: uniqueSorted(symbols),
  }
}

function cycleHotspot(findings: readonly AuditedFinding[]): CycleHotspot {
  const memberCounts = new Map<string, number>()
  for (const { finding } of findings) {
    if (finding.subject.kind !== 'cycle') {
      continue
    }
    for (const member of finding.subject.members) {
      memberCounts.set(member, (memberCounts.get(member) ?? 0) + 1)
    }
  }
  const members = [...memberCounts.keys()].sort(compareStrings)
  const paths = uniqueSorted(findings.flatMap(({ finding }) => {
    return [
      finding.primaryLocation.path,
      ...finding.relatedLocations.map(({ path }) => path),
    ]
  }))
  const hubModules = [...memberCounts.entries()]
    .sort(([leftPath, leftCount], [rightPath, rightCount]) => {
      return rightCount - leftCount || compareStrings(leftPath, rightPath)
    })
    .slice(0, 3)
    .map(([path]) => path)

  return {
    ...sharedFields(findings),
    id: hotspotId({ kind: 'cycle', members }),
    kind: 'cycle',
    members,
    paths,
    hubModules,
    runtimeCycleCount: findings.filter(({ finding }) => {
      return finding.rule === 'runtime-cycle'
    }).length,
    compileTimeCycleCount: findings.filter(({ finding }) => {
      return finding.rule === 'type-only-cycle'
    }).length,
  }
}

function sharedFields(
  findings: readonly AuditedFinding[],
): Omit<HotspotBase, 'id'> {
  return {
    severity: findings.some(({ finding }) => finding.severity === 'high')
      ? 'high'
      : 'advisory',
    findingCount: findings.length,
    rules: uniqueSorted(findings.map(({ finding }) => {
      return `${finding.detector}/${finding.rule}`
    })),
    fingerprints: uniqueSorted(findings.map(({ fingerprint }) => fingerprint)),
  }
}

function cycleComponents(
  findings: readonly AuditedFinding[],
): readonly (readonly AuditedFinding[])[] {
  const remaining = new Set(findings)
  const components: AuditedFinding[][] = []

  while (remaining.size > 0) {
    const first = remaining.values().next().value as AuditedFinding
    remaining.delete(first)
    const component = [first]
    const members = new Set(cycleMembers(first))

    let added = true
    while (added) {
      added = false
      for (const candidate of remaining) {
        if (!cycleMembers(candidate).some((member) => members.has(member))) {
          continue
        }
        remaining.delete(candidate)
        component.push(candidate)
        for (const member of cycleMembers(candidate)) {
          members.add(member)
        }
        added = true
      }
    }
    components.push(component)
  }

  return components
}

function cycleMembers(audited: AuditedFinding): readonly string[] {
  return audited.finding.subject.kind === 'cycle'
    ? audited.finding.subject.members
    : []
}

function hotspotId(identity: object): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
  return `hotspot-v1:${digest}`
}

function compareHotspots(left: Hotspot, right: Hotspot): number {
  const severity = severityRank(left.severity) - severityRank(right.severity)
  if (severity !== 0) {
    return severity
  }
  if (left.findingCount !== right.findingCount) {
    return right.findingCount - left.findingCount
  }
  return hotspotLabel(left).localeCompare(hotspotLabel(right), 'en')
}

function hotspotLabel(hotspot: Hotspot): string {
  return hotspot.kind === 'file'
    ? hotspot.path
    : hotspot.members.join('\u0000')
}

function severityRank(severity: FindingSeverity): number {
  return severity === 'high' ? 0 : 1
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings)
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}
