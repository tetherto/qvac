/** The four states a run records. */
export type TestOutcome = 'success' | 'failure' | 'skipped' | 'incomplete'

export interface RunReportTest {
  testId: string
  outcome: TestOutcome
  error?: string
  /** Set when outcome is incomplete; `error` may be absent. */
  incompleteReason?: string
}

/** The part of a run's `results-*.json` the comparison reads. */
export interface RunReport {
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
  tests: RunReportTest[]
}

/** The document `report:compare` writes and `report:format` renders. */
export interface ReportComparison {
  metadata: {
    baseline: { runId: string; timestamp: string }
    current: { runId: string; timestamp: string }
  }
  summary: {
    baseline: RunReport['summary']
    current: RunReport['summary']
    delta: number
  }
  categories: Record<
    string,
    {
      baseline: { passed: number; total: number }
      current: { passed: number; total: number }
      delta: number
    }
  >
  changes: ReportChanges
}

export interface ReportChanges {
  newFailures: Array<{ testId: string; error?: string }>
  /** Passed in the baseline, incomplete now. */
  coverageRegressions: Array<{ testId: string; reason?: string }>
  /** Passed in the baseline, skipped now. */
  newlySkipped: Array<{ testId: string; reason?: string }>
  fixedTests: Array<{ testId: string }>
  newTests: string[]
  removedTests: string[]
}

const reasonOf = (test: RunReportTest) => test.incompleteReason ?? test.error

function group(tests: readonly RunReportTest[]): Map<string, RunReportTest[]> {
  const byId = new Map<string, RunReportTest[]>()
  for (const test of tests) {
    const existing = byId.get(test.testId)
    if (existing) existing.push(test)
    else byId.set(test.testId, [test])
  }
  return byId
}

/**
 * What changed between two runs of the same catalog. A test that stops running matters as much as
 * one that starts failing, but the two ways it happens are kept apart: `incomplete` means the
 * client has no body or binding, which no machine can cause, while a skip can come from the
 * runner's own limits -- two GPUs, a reachable server, an opt-in flag.
 */
export function compareReports(baseline: RunReport, current: RunReport): ReportChanges {
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

    // A test can appear more than once in a run; the worst result decides.
    const baselineAllPassed = baselineRuns.every((test) => test.outcome === 'success')
    const failure = currentRuns.find((test) => test.outcome === 'failure')
    const incomplete = currentRuns.find((test) => test.outcome === 'incomplete')
    const skipped = currentRuns.find((test) => test.outcome === 'skipped')

    if (baselineAllPassed) {
      if (failure) {
        changes.newFailures.push({ testId, error: failure.error })
      } else if (incomplete) {
        changes.coverageRegressions.push({ testId, reason: reasonOf(incomplete) })
      } else if (skipped) {
        changes.newlySkipped.push({ testId, reason: reasonOf(skipped) })
      }
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
