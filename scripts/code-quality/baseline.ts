import { fingerprintFinding } from './fingerprint.js'
import type {
  Baseline,
  BaselineComparison,
  BaselineEntry,
  Finding,
  FindingChange,
  FindingCategory,
  FindingMeasurement,
  FindingSeverity,
  FindingSubject,
  SourceLocation,
} from './model.js'

export class BaselineError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BaselineError'
  }
}

export function createBaseline(findings: readonly Finding[]): Baseline {
  const entries = new Map<string, BaselineEntry>()

  for (const finding of findings) {
    const entry = snapshotFinding(finding)
    entries.set(entry.fingerprint, entry)
  }

  return {
    schemaVersion: 1,
    findings: [...entries.values()].sort(compareBaselineEntries),
  }
}

export function compareWithBaseline(
  findings: readonly Finding[],
  baseline: Baseline,
  resolutionPolicy: 'calculate' | 'withhold' = 'calculate',
): BaselineComparison {
  const baselineByFingerprint = new Map(
    baseline.findings.map((entry) => [entry.fingerprint, entry]),
  )
  const currentFingerprints = new Set<string>()
  const changes: FindingChange[] = []
  const audited = findings.map((finding) => {
    const fingerprint = fingerprintFinding(finding)
    currentFingerprints.add(fingerprint)
    const previous = baselineByFingerprint.get(fingerprint)
    if (previous !== undefined) {
      const change = compareFindingState(fingerprint, previous, finding)
      if (change !== undefined) {
        changes.push(change)
      }
    }

    return {
      fingerprint,
      status: previous !== undefined
        ? 'existing' as const
        : 'new' as const,
      finding,
    }
  })
  const resolutionStatus = resolutionPolicy === 'calculate'
    ? 'complete' as const
    : 'withheld' as const
  const resolved = resolutionStatus === 'complete'
    ? baseline.findings
      .filter((entry) => !currentFingerprints.has(entry.fingerprint))
      .sort(compareBaselineEntries)
    : []

  return {
    findings: audited,
    changes: changes.sort(compareFindingChanges),
    resolutionStatus,
    resolved,
  }
}

function compareFindingState(
  fingerprint: string,
  previous: BaselineEntry,
  current: Finding,
): FindingChange | undefined {
  const severity = previous.severity === current.severity
    ? undefined
    : { before: previous.severity, after: current.severity }
  const previousMeasurement = measurementState(previous.measurement)
  const currentMeasurement = measurementState(current.measurement)
  const measurement = measurementsEqual(previousMeasurement, currentMeasurement)
    ? undefined
    : { before: previousMeasurement, after: currentMeasurement }

  if (severity === undefined && measurement === undefined) {
    return undefined
  }

  return {
    fingerprint,
    detector: current.detector,
    rule: current.rule,
    subject: current.subject,
    primaryLocation: current.primaryLocation,
    ...(severity === undefined ? {} : { severity }),
    ...(measurement === undefined ? {} : { measurement }),
  }
}

function measurementState(
  measurement: FindingMeasurement | undefined,
): { readonly value: number; readonly unit: string } | null {
  return measurement === undefined
    ? null
    : { value: measurement.value, unit: measurement.unit }
}

function measurementsEqual(
  left: { readonly value: number; readonly unit: string } | null,
  right: { readonly value: number; readonly unit: string } | null,
): boolean {
  return left?.value === right?.value
    && left?.unit === right?.unit
    && (left === null) === (right === null)
}

function compareFindingChanges(left: FindingChange, right: FindingChange): number {
  return left.fingerprint.localeCompare(right.fingerprint, 'en')
}

export function parseBaseline(source: string): Baseline {
  let value: unknown

  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new BaselineError('Baseline is not valid JSON', { cause: error })
  }

  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.findings)) {
    throw new BaselineError('Baseline must have schemaVersion 1 and a findings array')
  }

  const findings = value.findings.map((entry, index) => {
    return parseBaselineEntry(entry, index)
  })
  const fingerprints = new Set(findings.map((entry) => entry.fingerprint))

  if (fingerprints.size !== findings.length) {
    throw new BaselineError('Baseline contains duplicate fingerprints')
  }

  return {
    schemaVersion: 1,
    findings: [...findings].sort(compareBaselineEntries),
  }
}

function snapshotFinding(finding: Finding): BaselineEntry {
  const shared = {
    fingerprint: fingerprintFinding(finding),
    detector: finding.detector,
    rule: finding.rule,
    category: finding.category,
    severity: finding.severity,
    subject: finding.subject,
    summary: finding.summary,
    remediation: finding.remediation,
    primaryLocation: finding.primaryLocation,
  }

  return finding.measurement === undefined
    ? shared
    : { ...shared, measurement: finding.measurement }
}

function parseBaselineEntry(value: unknown, index: number): BaselineEntry {
  if (!isRecord(value)) {
    throw invalidEntry(index)
  }

  const fingerprint = readString(value.fingerprint, index)
  const detector = readString(value.detector, index)
  const rule = readString(value.rule, index)
  const category = readCategory(value.category, index)
  const severity = readSeverity(value.severity, index)
  const subject = readSubject(value.subject, index)
  const summary = readString(value.summary, index)
  const remediation = readString(value.remediation, index)
  const primaryLocation = readLocation(value.primaryLocation, index)
  const measurement = value.measurement === undefined
    ? undefined
    : readMeasurement(value.measurement, index)

  if (!/^quality-v1:[a-f0-9]{64}$/.test(fingerprint)) {
    throw invalidEntry(index)
  }

  return measurement === undefined
    ? {
      fingerprint,
      detector,
      rule,
      category,
      severity,
      subject,
      summary,
      remediation,
      primaryLocation,
    }
    : {
      fingerprint,
      detector,
      rule,
      category,
      severity,
      subject,
      summary,
      remediation,
      primaryLocation,
      measurement,
    }
}

function readSubject(value: unknown, index: number): FindingSubject {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw invalidEntry(index)
  }

  if (value.kind === 'file' && typeof value.path === 'string') {
    return { kind: 'file', path: value.path }
  }
  if (
    value.kind === 'function'
    && typeof value.path === 'string'
    && typeof value.symbol === 'string'
  ) {
    return { kind: 'function', path: value.path, symbol: value.symbol }
  }
  if (
    value.kind === 'cycle'
    && Array.isArray(value.members)
    && value.members.length > 0
    && value.members.every((member) => typeof member === 'string')
  ) {
    return { kind: 'cycle', members: value.members }
  }

  throw invalidEntry(index)
}

function readLocation(value: unknown, index: number): SourceLocation {
  if (!isRecord(value) || typeof value.path !== 'string') {
    throw invalidEntry(index)
  }

  const line = readOptionalNumber(value.line, index)
  const column = readOptionalNumber(value.column, index)

  return {
    path: value.path,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  }
}

function readMeasurement(value: unknown, index: number): FindingMeasurement {
  if (
    !isRecord(value)
    || typeof value.value !== 'number'
    || !Number.isFinite(value.value)
    || typeof value.unit !== 'string'
  ) {
    throw invalidEntry(index)
  }

  const advisoryThreshold = readOptionalNumber(value.advisoryThreshold, index)
  const highThreshold = readOptionalNumber(value.highThreshold, index)

  return {
    value: value.value,
    unit: value.unit,
    ...(advisoryThreshold === undefined ? {} : { advisoryThreshold }),
    ...(highThreshold === undefined ? {} : { highThreshold }),
  }
}

function readOptionalNumber(value: unknown, index: number): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidEntry(index)
  }
  return value
}

function readString(value: unknown, index: number): string {
  if (typeof value !== 'string') {
    throw invalidEntry(index)
  }
  return value
}

function readCategory(value: unknown, index: number): FindingCategory {
  const categories: readonly FindingCategory[] = [
    'complexity',
    'dependency',
    'nesting',
    'size',
    'workspace-dependency',
  ]

  if (!categories.includes(value as FindingCategory)) {
    throw invalidEntry(index)
  }
  return value as FindingCategory
}

function readSeverity(value: unknown, index: number): FindingSeverity {
  if (value !== 'advisory' && value !== 'high') {
    throw invalidEntry(index)
  }
  return value
}

function invalidEntry(index: number): BaselineError {
  return new BaselineError(`Baseline finding at index ${index} is malformed`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareBaselineEntries(left: BaselineEntry, right: BaselineEntry): number {
  return left.fingerprint.localeCompare(right.fingerprint, 'en')
}
