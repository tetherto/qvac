import type { Hotspot } from './hotspots.js'
import type {
  TriageCandidate,
  TriageLifecycle,
  TriageReport,
} from './triage-model.js'

export type TriageLifecycleState = keyof TriageLifecycle

export interface TriageRenderOptions {
  readonly limit?: number
  readonly offset?: number
  readonly kind?: Hotspot['kind']
  readonly lifecycle?: TriageLifecycleState
}

export function renderTriageJson(report: TriageReport): string {
  const normalized: TriageReport = {
    schemaVersion: 1,
    sourceReportHash: report.sourceReportHash,
    resolutionStatus: report.resolutionStatus,
    candidates: [...report.candidates].sort(compareCandidates),
  }
  return `${JSON.stringify(normalized, undefined, 2)}\n`
}

export function renderTriageMarkdown(
  report: TriageReport,
  options: TriageRenderOptions = {},
): string {
  const limit = options.limit ?? 10
  const offset = options.offset ?? 0
  const candidates = [...report.candidates]
    .sort(compareCandidates)
    .filter((candidate) => {
      return (options.kind === undefined || candidate.hotspot.kind === options.kind)
        && (
          options.lifecycle === undefined
          || candidate.lifecycle[options.lifecycle] > 0
        )
    })
  const visible = candidates.slice(offset, offset + limit)
  const first = candidates.length === 0 ? 0 : offset + 1
  const last = Math.min(offset + visible.length, candidates.length)
  const lines = [
    '# Code Quality Triage',
    '',
    `**${candidates.length} candidate groups** · Showing ${first}–${last} of ${candidates.length} candidate groups`,
    '',
    'These are deterministic evidence groups. Use `qv-quality-reporting` for contextual priority, ownership, and ticket proposals.',
    '',
  ]

  if (visible.length === 0) {
    return `${[...lines, '_No candidates match the filters._'].join('\n')}\n`
  }

  for (const candidate of visible) {
    lines.push(...renderCandidate(candidate))
  }
  if (last < candidates.length) {
    lines.push(`_Next page: offset ${last}._`, '')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function renderCandidate(candidate: TriageCandidate): readonly string[] {
  const hotspot = candidate.hotspot
  const location = hotspot.kind === 'file'
    ? hotspot.path
    : hotspot.hubModules.join(', ')
  const evidence = hotspot.kind === 'file'
    ? fileEvidence(candidate)
    : cycleEvidence(candidate)
  const lifecycle = Object.entries(candidate.lifecycle)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(', ')
  const churn = candidate.git.reduce((sum, item) => sum + item.commitCount, 0)
  const lastChanged = candidate.git
    .flatMap(({ lastChanged: date }) => date === undefined ? [] : [date])
    .sort(compareStrings)
    .at(-1)
  const history = lastChanged === undefined
    ? `${churn} commits in the 180-day window`
    : `${churn} commits in the 180-day window; last changed ${lastChanged}`
  const drift = driftEvidence(candidate)

  return [
    `## ${candidate.activeSeverity === null ? 'Resolved' : capitalize(candidate.activeSeverity)} · ${location}`,
    '',
    evidence,
    '',
    `- **Group:** \`${candidate.id}\``,
    `- **Lifecycle:** ${lifecycle || 'unchanged'}`,
    ...(drift === undefined ? [] : [`- **Drift:** ${drift}`]),
    `- **Rules:** ${hotspot.rules.map((rule) => `\`${rule}\``).join(', ')}`,
    `- **History:** ${history}`,
    `- **Source:** ${candidate.sourceProfile}`,
    ...(candidate.maxThresholdRatio === null
      ? []
      : [`- **Largest threshold multiple:** ${candidate.maxThresholdRatio}× advisory`]),
    '',
  ]
}

function fileEvidence(candidate: TriageCandidate): string {
  if (candidate.hotspot.kind !== 'file') {
    return ''
  }
  const symbolDetail = candidate.hotspot.symbols.length === 0
    ? 'file-level evidence'
    : `affected symbols: ${candidate.hotspot.symbols.join(', ')}`
  const findingCount = activeCountLabel(candidate)
  return `${findingCount} related findings overlap in this file (${symbolDetail}). Review them as one candidate remediation boundary before splitting.`
}

function cycleEvidence(candidate: TriageCandidate): string {
  if (candidate.hotspot.kind !== 'cycle') {
    return ''
  }
  const total = candidate.hotspot.runtimeCycleCount
    + candidate.hotspot.compileTimeCycleCount
  const cycleCounts = candidate.activeFindingCount === total
    ? `${candidate.hotspot.runtimeCycleCount} runtime and ${candidate.hotspot.compileTimeCycleCount} compile-time cycle paths`
    : `${candidate.activeFindingCount} active of ${total} related cycle paths`
  return `${cycleCounts} overlap across ${candidate.hotspot.members.length} modules. Review the shared dependency boundary rather than treating each path as a separate task.`
}

function compareCandidates(
  left: TriageCandidate,
  right: TriageCandidate,
): number {
  return severityRank(left) - severityRank(right)
    || lifecycleRank(left) - lifecycleRank(right)
    || right.activeFindingCount - left.activeFindingCount
    || right.git.reduce((sum, item) => sum + item.commitCount, 0)
      - left.git.reduce((sum, item) => sum + item.commitCount, 0)
    || left.id.localeCompare(right.id, 'en')
}

function severityRank(candidate: TriageCandidate): number {
  if (candidate.activeSeverity === 'high') {
    return 0
  }
  return candidate.activeSeverity === 'advisory' ? 1 : 2
}

function lifecycleRank(candidate: TriageCandidate): number {
  if (candidate.lifecycle.new > 0) {
    return 0
  }
  if (candidate.changes.some(({ direction }) => direction !== 'improved')) {
    return 1
  }
  if (candidate.lifecycle.resolved > 0 && candidate.lifecycle.existing === 0) {
    return 2
  }
  return candidate.lifecycle.changed > 0 ? 3 : 4
}

function activeCountLabel(candidate: TriageCandidate): string {
  return candidate.activeFindingCount === candidate.hotspot.findingCount
    ? String(candidate.activeFindingCount)
    : `${candidate.activeFindingCount} active of ${candidate.hotspot.findingCount}`
}

function driftEvidence(candidate: TriageCandidate): string | undefined {
  if (candidate.changes.length === 0) {
    return undefined
  }
  const counts = new Map<string, number>()
  for (const { direction } of candidate.changes) {
    counts.set(direction, (counts.get(direction) ?? 0) + 1)
  }
  const summary = ['worsened', 'improved', 'mixed']
    .flatMap((direction) => {
      const count = counts.get(direction)
      return count === undefined ? [] : [`${count} ${direction}`]
    })
    .join(', ')
  const examples = candidate.changes.slice(0, 3).flatMap((change) => {
    const measurement = change.measurement
    if (measurement?.before === null || measurement?.after === null || measurement === undefined) {
      return []
    }
    return [`${measurement.before.value}→${measurement.after.value} ${measurement.after.unit}`]
  })
  return examples.length === 0 ? summary : `${summary} (${examples.join('; ')})`
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}
