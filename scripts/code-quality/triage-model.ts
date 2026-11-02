import type { GitPathHistory } from './git-history.js'
import type { Hotspot } from './hotspots.js'
import type {
  FindingChange,
  FindingMeasurement,
  FindingSeverity,
} from './model.js'

export interface TriageLifecycle {
  readonly new: number
  readonly changed: number
  readonly existing: number
  readonly resolved: number
}

export interface TriageCandidate {
  readonly id: string
  readonly hotspot: Hotspot
  readonly lifecycle: TriageLifecycle
  readonly severityCounts: Readonly<Record<FindingSeverity, number>>
  readonly activeFindingCount: number
  readonly activeSeverity: FindingSeverity | null
  readonly findingEvidence: readonly TriageFindingEvidence[]
  readonly changes: readonly TriageFindingChange[]
  readonly sourceProfile: 'production' | 'auxiliary' | 'mixed'
  readonly maxThresholdRatio: number | null
  readonly git: readonly GitPathHistory[]
}

export interface TriageFindingEvidence {
  readonly fingerprint: string
  readonly lifecycle: 'new' | 'changed' | 'existing' | 'resolved'
  readonly severity: FindingSeverity
  readonly measurement?: FindingMeasurement
}

export interface TriageFindingChange extends FindingChange {
  readonly direction: 'worsened' | 'improved' | 'mixed'
}

export interface TriageReport {
  readonly schemaVersion: 1
  readonly sourceReportHash: string
  readonly resolutionStatus: 'complete' | 'withheld'
  readonly candidates: readonly TriageCandidate[]
}
