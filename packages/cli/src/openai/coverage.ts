import { buildCoverageReport } from './coverage/build-report.js'
import { filterCoverageRows, formatCoverageReportHuman } from './coverage/format.js'

export interface RunOpenAiCoverageOptions {
  json?: boolean
  unsupported?: boolean
  unknown?: boolean
  primaryAi?: boolean
  consumerPrimary?: boolean
  offline?: boolean
}

export async function runOpenAiCoverage(options: RunOpenAiCoverageOptions = {}): Promise<void> {
  const buildOpts: Parameters<typeof buildCoverageReport>[0] = {}
  if (options.offline) buildOpts.offline = true
  const report = await buildCoverageReport(buildOpts)

  const filterOpts: Parameters<typeof filterCoverageRows>[1] = {}
  if (options.unsupported) filterOpts.unsupported = true
  if (options.unknown) filterOpts.unknown = true
  if (options.primaryAi) filterOpts.primaryAi = true
  if (options.consumerPrimary) filterOpts.consumerPrimary = true
  const filtered = filterCoverageRows(report, filterOpts)

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, rows: filtered }, null, 2)}\n`)
    return
  }

  const listOnlyUnsupported =
    options.unsupported && !options.unknown && !options.primaryAi && !options.consumerPrimary
  if (listOnlyUnsupported) {
    for (const row of filtered) {
      process.stdout.write(`${row.method} ${row.path}\n`)
    }
    return
  }

  process.stdout.write(`${formatCoverageReportHuman(report, filtered)}\n`)
}
