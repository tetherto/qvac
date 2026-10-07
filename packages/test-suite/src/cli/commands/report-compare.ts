import * as fs from 'node:fs'
import * as path from 'node:path'
import { compareReports, type ComparedReport } from '../../utils/compare-reports.js'

interface CompareOptions {
  baseline: string
  current: string
  output: string
}

// lunte-disable-next-line require-await
export async function reportCompare(options: CompareOptions) {
  try {
    console.log('📊 Comparing test results...\n')

    // Load baseline
    const baselineData = fs.readFileSync(options.baseline, 'utf-8') as string
    const baseline: ComparedReport = JSON.parse(baselineData)
    console.log(
      `📋 Baseline: ${baseline.runId} (${baseline.summary.passed}/${baseline.summary.total} passed)`
    )

    // Load current
    const currentData = fs.readFileSync(options.current, 'utf-8') as string
    const current: ComparedReport = JSON.parse(currentData)
    console.log(
      `📋 Current:  ${current.runId} (${current.summary.passed}/${current.summary.total} passed)\n`
    )

    const changes = compareReports(baseline, current)

    // Category comparison
    const categoryChanges: Record<
      string,
      {
        baseline: { passed: number; total: number }
        current: { passed: number; total: number }
        delta: number
      }
    > = {}

    for (const category in current.categories) {
      const curr = current.categories[category]
      const base = baseline.categories[category] || { passed: 0, failed: 0, total: 0 }
      categoryChanges[category] = {
        baseline: { passed: base.passed, total: base.total },
        current: { passed: curr.passed, total: curr.total },
        delta: curr.passed - base.passed
      }
    }

    // Build comparison result
    const comparison = {
      metadata: {
        baseline: { runId: baseline.runId, timestamp: new Date().toISOString() },
        current: { runId: current.runId, timestamp: new Date().toISOString() }
      },
      summary: {
        baseline: baseline.summary,
        current: current.summary,
        delta: current.summary.passed - baseline.summary.passed
      },
      categories: categoryChanges,
      changes
    }

    // Write comparison
    const outputPath = path.resolve(options.output)
    fs.writeFileSync(outputPath, JSON.stringify(comparison, null, 2))

    console.log(`✅ Comparison saved: ${outputPath}`)
    console.log(`\n📊 Summary:`)
    console.log(`   New failures: ${changes.newFailures.length}`)
    console.log(`   Coverage regressions: ${changes.coverageRegressions.length}`)
    console.log(`   Newly skipped: ${changes.newlySkipped.length}`)
    console.log(`   Fixed tests: ${changes.fixedTests.length}`)
    console.log(`   New tests: ${changes.newTests.length}`)
    console.log(`   Removed tests: ${changes.removedTests.length}`)
    console.log(
      `   Overall delta: ${comparison.summary.delta > 0 ? '+' : ''}${comparison.summary.delta}`
    )

    // Failing here is the point: a test that stopped running leaves every other check green.
    if (changes.coverageRegressions.length > 0) {
      console.error(
        `\n❌ ${changes.coverageRegressions.length} test(s) passed in the baseline and this client no longer runs:`
      )
      for (const regression of changes.coverageRegressions) {
        console.error(
          `   ${regression.testId}${regression.reason ? ` -- ${regression.reason}` : ''}`
        )
      }
      process.exitCode = 1
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('❌ Comparison failed:', errorMessage)
    process.exit(1)
  }
}
