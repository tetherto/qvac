import { buildCoverageReport } from '../../src/openai/coverage/build-report'
import type { CoverageReport, CoverageRow } from '../../src/openai/coverage/types'
import type { OpenAiApiCoverageSnapshot, OpenAiCoverageMetric } from './types'

export type CoverageReportBuilder = (options?: { offline?: boolean }) => Promise<CoverageReport>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function uncoveredKeys(rows: CoverageRow[]): string[] {
  return rows
    .filter((row) => !row.implemented)
    .map((row) => row.key)
    .sort()
}

function metric(
  summary: { implemented: number; total: number; percent: number },
  rows: CoverageRow[]
): OpenAiCoverageMetric {
  return {
    implemented: summary.implemented,
    total: summary.total,
    percent: summary.percent,
    uncovered: uncoveredKeys(rows)
  }
}

function availableSnapshot(report: CoverageReport, warnings: string[]): OpenAiApiCoverageSnapshot {
  const consumerPrimaryRows = report.rows.filter((row) => row.consumerPrimary)
  const primaryAiRows = report.rows.filter((row) => row.category === 'primary-ai')
  return {
    status: 'available',
    source_mode: report.specSourceMode,
    captured_at: report.fetchedAt,
    spec_source: report.specSource,
    spec_sha256: report.specSha256,
    spec_endpoint_count: report.rows.length,
    router_source: report.routerSource,
    router_implemented_count: report.implementedCount,
    consumer_primary: metric(report.summary.consumerPrimary, consumerPrimaryRows),
    primary_ai: metric(report.summary.byCategory['primary-ai'], primaryAiRows),
    extensions: [...report.extensions].sort(),
    warnings
  }
}

export async function captureOpenAiApiCoverage(
  buildReport: CoverageReportBuilder = buildCoverageReport,
  now: () => Date = () => new Date()
): Promise<OpenAiApiCoverageSnapshot> {
  try {
    const report = await buildReport({})
    return availableSnapshot(report, [])
  } catch (liveError) {
    const liveMessage = errorMessage(liveError)
    try {
      const report = await buildReport({ offline: true })
      return availableSnapshot(report, [
        `Live OpenAI coverage build failed; used offline specification cache: ${liveMessage}`
      ])
    } catch (offlineError) {
      return {
        status: 'unavailable',
        captured_at: now().toISOString(),
        errors: [
          `Live OpenAI coverage build failed: ${liveMessage}`,
          `Offline OpenAI coverage build failed: ${errorMessage(offlineError)}`
        ]
      }
    }
  }
}
