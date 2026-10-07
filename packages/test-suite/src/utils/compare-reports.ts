/** The four states a run records. The comparison used to admit only the first two. */
export type TestOutcome = 'success' | 'failure' | 'skipped' | 'incomplete'

export interface ComparedTest {
  testId: string
  outcome: TestOutcome
  error?: string
}

export interface ComparedReport {
  runId: string
  summary: {
    total: number
    passed: number
    failed: number
    skipped?: number
    incomplete?: number
    duration: number
  }
  categories: Record<string, { passed: number; failed: number; total: number }>
  tests: ComparedTest[]
}

export interface ReportChanges {
  newFailures: Array<{ testId: string; error?: string }>
  /** Passed in the baseline, and this run had no body or binding for it. */
  coverageRegressions: Array<{ testId: string; reason?: string }>
  /** Passed in the baseline, and this run skipped it. Reported, never fatal -- see below. */
  newlySkipped: Array<{ testId: string; reason?: string }>
  fixedTests: Array<{ testId: string }>
  newTests: string[]
  removedTests: string[]
}

function group(tests: readonly ComparedTest[]): Map<string, ComparedTest[]> {
  const byId = new Map<string, ComparedTest[]>()
  for (const test of tests) {
    const existing = byId.get(test.testId)
    if (existing) existing.push(test)
    else byId.set(test.testId, [test])
  }
  return byId
}

/**
 * What changed between two runs of the same catalog.
 *
 * A test that stops running is a regression as real as one that starts failing: the gate stays
 * green while the client quietly covers less. The two ways that happens are kept apart, because
 * only one of them is the client's doing:
 *
 * - `incomplete` means this client has no body or binding for the test. Nothing about the machine
 *   can cause it, so a pass that turns incomplete is a defect.
 * - `skipped` also covers the runner's own limits -- two GPUs, a reachable LAN server, an opt-in
 *   env flag -- which legitimately differ between the baseline machine and this one.
 */
export function compareReports(baseline: ComparedReport, current: ComparedReport): ReportChanges {
  const baselineById = group(baseline.tests)
  const currentById = group(current.tests)

  const changes: ReportChanges = {
    newFailures: [],
    coverageRegressions: [],
    newlySkipped: [],
    fixedTests: [],
    newTests: [],
    removedTests: []
  }

  for (const [testId, currentRuns] of currentById) {
    const baselineRuns = baselineById.get(testId)
    if (!baselineRuns) {
      changes.newTests.push(testId)
      continue
    }

    // A test can appear more than once in a run; the worst result of the set decides.
    const baselineAllPassed = baselineRuns.every((test) => test.outcome === 'success')
    const failure = currentRuns.find((test) => test.outcome === 'failure')
    const incomplete = currentRuns.find((test) => test.outcome === 'incomplete')
    const skipped = currentRuns.find((test) => test.outcome === 'skipped')

    if (baselineAllPassed) {
      if (failure) changes.newFailures.push({ testId, error: failure.error })
      else if (incomplete) changes.coverageRegressions.push({ testId, reason: incomplete.error })
      else if (skipped) changes.newlySkipped.push({ testId, reason: skipped.error })
      continue
    }

    const baselineHasFailure = baselineRuns.some((test) => test.outcome === 'failure')
    if (baselineHasFailure && currentRuns.every((test) => test.outcome === 'success')) {
      changes.fixedTests.push({ testId })
    }
  }

  for (const testId of baselineById.keys()) {
    if (!currentById.has(testId)) changes.removedTests.push(testId)
  }

  return changes
}
