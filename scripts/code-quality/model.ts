export type FindingSeverity = 'advisory' | 'high'

export type FindingCategory =
  | 'complexity'
  | 'dependency'
  | 'nesting'
  | 'size'
  | 'workspace-dependency'

export interface SourceLocation {
  readonly path: string
  readonly line?: number
  readonly column?: number
}

export type FindingSubject =
  | {
    readonly kind: 'file'
    readonly path: string
  }
  | {
    readonly kind: 'function'
    readonly path: string
    readonly symbol: string
  }
  | {
    readonly kind: 'cycle'
    readonly members: readonly string[]
  }

export interface FindingMeasurement {
  readonly value: number
  readonly unit: string
  readonly advisoryThreshold?: number
  readonly highThreshold?: number
}

export interface Finding {
  readonly detector: string
  readonly rule: string
  readonly category: FindingCategory
  readonly severity: FindingSeverity
  readonly subject: FindingSubject
  readonly summary: string
  readonly explanation: string
  readonly remediation: string
  readonly primaryLocation: SourceLocation
  readonly relatedLocations: readonly SourceLocation[]
  readonly measurement?: FindingMeasurement
}

export interface AnalysisDiagnostic {
  readonly detector: string
  readonly code: string
  readonly message: string
  readonly location?: SourceLocation
}

export interface DetectorCoverage {
  readonly detector: string
  readonly version: string
  readonly filesAnalyzed?: number
  readonly modulesAnalyzed?: number
  readonly workspacesAnalyzed?: number
  readonly unresolvedImportsExempted?: number
}

export interface AnalysisResult {
  readonly schemaVersion: 1
  readonly coverage: readonly DetectorCoverage[]
  readonly findings: readonly Finding[]
  readonly diagnostics: readonly AnalysisDiagnostic[]
}

export interface AuditedFinding {
  readonly fingerprint: string
  readonly status: 'existing' | 'new'
  readonly finding: Finding
}

export interface BaselineEntry {
  readonly fingerprint: string
  readonly detector: string
  readonly rule: string
  readonly category: FindingCategory
  readonly severity: FindingSeverity
  readonly subject: FindingSubject
  readonly summary: string
  readonly remediation: string
  readonly primaryLocation: SourceLocation
  readonly measurement?: FindingMeasurement
}

export interface Baseline {
  readonly schemaVersion: 1
  readonly findings: readonly BaselineEntry[]
}

export interface FindingChange {
  readonly fingerprint: string
  readonly detector: string
  readonly rule: string
  readonly subject: FindingSubject
  readonly primaryLocation: SourceLocation
  readonly severity?: {
    readonly before: FindingSeverity
    readonly after: FindingSeverity
  }
  readonly measurement?: {
    readonly before: {
      readonly value: number
      readonly unit: string
    } | null
    readonly after: {
      readonly value: number
      readonly unit: string
    } | null
  }
}

export interface BaselineComparison {
  readonly findings: readonly AuditedFinding[]
  readonly changes: readonly FindingChange[]
  readonly resolutionStatus: 'complete' | 'withheld'
  readonly resolved: readonly BaselineEntry[]
}

export type AuditedAnalysisResult = Omit<AnalysisResult, 'findings'>
  & BaselineComparison
