import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Folds per-run reports into a testId x client matrix: a feature may be claimed on a client only
 * where the matrix says `pass`.
 */

export interface MatrixOptions {
  /** `label=path` pairs, e.g. `desktop=reports/a/results-x.json`. */
  report: string[]
  output?: string
  /** Exit non-zero if any client asserted a different value than another. */
  failOnDrift?: boolean
}

type Cell = 'pass' | 'fail' | 'skipped' | 'incomplete' | 'absent'

interface ReportTest {
  testId: string
  outcome: 'success' | 'failure' | 'skipped' | 'incomplete'
  error?: string
  incompleteReason?: string
  assertedValue?: unknown
}

interface Report {
  runId: string
  tests: ReportTest[]
}

const CELL: Record<ReportTest['outcome'], Cell> = {
  success: 'pass',
  failure: 'fail',
  skipped: 'skipped',
  incomplete: 'incomplete'
}

const ICON: Record<Cell, string> = {
  pass: '✅',
  fail: '❌',
  skipped: '⏭️',
  incomplete: '🚧',
  absent: '·'
}

function parseReportArg(arg: string): { label: string; file: string } {
  const at = arg.indexOf('=')
  if (at === -1) {
    throw new Error(`--report expects label=path, got "${arg}"`)
  }
  return { label: arg.slice(0, at), file: arg.slice(at + 1) }
}

// lunte-disable-next-line require-await
export async function reportMatrix(options: MatrixOptions) {
  try {
    const sources = (options.report ?? []).map(parseReportArg)
    if (sources.length === 0) {
      throw new Error('at least one --report label=path is required')
    }

    const byClient = new Map<string, Map<string, ReportTest>>()
    for (const { label, file } of sources) {
      const report = JSON.parse(fs.readFileSync(file, 'utf-8')) as Report
      const tests = new Map(report.tests.map((t) => [t.testId, t]))
      byClient.set(label, tests)
      console.log(`📋 ${label}: ${report.runId} (${tests.size} tests)`)
    }

    const clients = [...byClient.keys()]
    const testIds = [...new Set(clients.flatMap((c) => [...byClient.get(c)!.keys()]))].sort()

    const rows = testIds.map((testId) => {
      const cells: Record<string, Cell> = {}
      const reasons: Record<string, string> = {}
      const asserted: Record<string, unknown> = {}

      for (const client of clients) {
        const test = byClient.get(client)!.get(testId)
        if (!test) {
          // The client's run never mentioned this test at all. Distinct from a skip: nobody decided
          // anything about it.
          cells[client] = 'absent'
          continue
        }
        cells[client] = CELL[test.outcome]
        const reason = test.incompleteReason ?? test.error
        if (reason) reasons[client] = reason
        if (test.assertedValue !== undefined) asserted[client] = test.assertedValue
      }

      // Only compare where at least two clients ran to a verdict. The comparison cannot tell a
      // client divergence from a test that samples freely, so `--fail-on-drift` is only a gate over
      // the deterministic part of the catalog.
      const compared = Object.entries(asserted).filter(([c]) => cells[c] === 'pass')
      const drift =
        compared.length > 1 && new Set(compared.map(([, v]) => JSON.stringify(v))).size > 1

      return { testId, cells, reasons, asserted, drift }
    })

    const claimable = rows.filter((r) => clients.every((c) => r.cells[c] === 'pass')).length
    const drifted = rows.filter((r) => r.drift)

    console.log(`\n${'='.repeat(80)}`)
    console.log('🧾 RELEASE CLAIM MATRIX')
    console.log('='.repeat(80))
    console.log(`Clients: ${clients.join(', ')}`)
    console.log(`Tests:   ${rows.length}`)
    console.log(`Claimable on every client: ${claimable}/${rows.length}\n`)

    const width = Math.max(...rows.map((r) => r.testId.length), 8)
    console.log(`${'test'.padEnd(width)}  ${clients.map((c) => c.padEnd(12)).join('')}`)
    for (const row of rows) {
      const cells = clients.map((c) => `${ICON[row.cells[c]]} ${row.cells[c]}`.padEnd(12)).join('')
      console.log(`${row.testId.padEnd(width)}  ${cells}${row.drift ? ' ⚠️  value drift' : ''}`)
    }

    // Per-client totals, so a shrinking `incomplete` column is visible release over release — that
    // is the number this whole exercise is meant to move.
    console.log('\nPer client:')
    for (const client of clients) {
      const count = (cell: Cell) => rows.filter((r) => r.cells[client] === cell).length
      console.log(
        `   ${client.padEnd(16)} pass ${count('pass')}  fail ${count('fail')}  ` +
          `skipped ${count('skipped')}  incomplete ${count('incomplete')}  absent ${count('absent')}`
      )
    }

    if (drifted.length > 0) {
      console.log(
        `\n⚠️  ${drifted.length} test(s) passed on more than one client with different values:`
      )
      for (const row of drifted) {
        console.log(`   ${row.testId}`)
        for (const client of clients) {
          if (row.asserted[client] !== undefined) {
            console.log(`      ${client}: ${JSON.stringify(row.asserted[client]).slice(0, 160)}`)
          }
        }
      }
    }

    if (options.output) {
      const out = {
        generatedAt: new Date().toISOString(),
        clients,
        summary: {
          tests: rows.length,
          claimableOnEveryClient: claimable,
          valueDrift: drifted.length
        },
        tests: rows
      }
      fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
      fs.writeFileSync(options.output, JSON.stringify(out, null, 2))
      console.log(`\n📄 Matrix written to ${options.output}`)
    }

    if (options.failOnDrift && drifted.length > 0) {
      process.exit(1)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('❌ Failed to build the matrix:', message)
    process.exit(1)
  }
}
