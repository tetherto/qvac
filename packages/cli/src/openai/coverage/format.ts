import type { CoverageCategory, CoverageReport, CoverageRow } from './types.js'

function tagLabel (row: CoverageRow): string {
  const parts = [...row.tags]
  if (row.group && !parts.includes(row.group)) parts.push(row.group)
  return parts.length > 0 ? `(${parts.join(', ')})` : ''
}

function formatCategoryLine (
  label: string,
  summary: { implemented: number; total: number; percent: number }
): string {
  const impl = String(summary.implemented).padStart(3)
  const total = String(summary.total).padStart(3)
  const pct = summary.percent.toFixed(1).padStart(5)
  return `  ${label.padEnd(14)} ${impl} / ${total}   (${pct}%)`
}

function appendUnknownNotice (lines: string[], report: CoverageReport): void {
  const unknownTotal = report.summary.byCategory.unknown.total
  if (unknownTotal === 0 || !report.summary.unknownBreakdown?.length) return

  const opWord = unknownTotal === 1 ? 'operation' : 'operations'
  lines.push('Unmapped OpenAI spec labels')
  lines.push('')
  lines.push(
    `${unknownTotal} ${opWord} in the upstream OpenAPI spec do not map to any coverage category (primary-ai, ai-secondary, platform). They are counted under "unknown" below until categorize.ts is updated.`
  )
  lines.push('')
  lines.push('Labels not in our category tables (OpenAPI tag or x-oaiMeta.group):')
  for (const item of report.summary.unknownBreakdown) {
    const kind = item.kind === 'tag' ? 'tag' : 'x-oaiMeta.group'
    lines.push(
      `  ${String(item.count).padStart(3)}  ${kind}: ${item.label}`
    )
  }
  lines.push('')
  lines.push(
    '  Extend PRIMARY_TAGS / AI_SECONDARY_TAGS / PLATFORM_TAGS or GROUP_CATEGORY in src/openai/coverage/categorize.ts'
  )
  lines.push('  List affected endpoints: qvac openai coverage --unknown')
  lines.push('')
}

export function formatCoverageReportHuman (
  report: CoverageReport,
  rows: CoverageRow[]
): string {
  const lines: string[] = []
  lines.push('qvac serve openai — coverage')
  lines.push('')
  appendUnknownNotice(lines, report)
  lines.push(`Spec: ${report.specSource} (${report.rows.length} endpoints)`)
  lines.push(
    `Router: ${report.routerSource} (${report.implementedCount} implemented)`
  )
  lines.push('')
  lines.push('Coverage by category:')
  const cats: Array<{ key: CoverageCategory; label: string }> = [
    { key: 'primary-ai', label: 'primary-ai' },
    { key: 'ai-secondary', label: 'ai-secondary' },
    { key: 'platform', label: 'platform' }
  ]
  if (report.summary.byCategory.unknown.total > 0) {
    cats.push({ key: 'unknown', label: 'unknown' })
  }
  for (const { key, label } of cats) {
    lines.push(formatCategoryLine(label, report.summary.byCategory[key]))
  }
  lines.push('')
  const cp = report.summary.consumerPrimary
  lines.push(
    `Primary AI surface (consumer-demanded): ${cp.implemented} / ${cp.total} (${cp.percent}%)`
  )
  lines.push('')
  lines.push('Endpoints:')
  for (const row of rows) {
    const mark = row.implemented ? '[x]' : '[ ]'
    const tag = tagLabel(row)
    const tagSuffix = tag ? `     ${tag}` : ''
    lines.push(
      `  ${mark} ${row.method} ${row.path}`.padEnd(52) +
        `${row.category}${tagSuffix}`
    )
    for (const caveat of row.caveats) {
      lines.push(`      caveat: ${caveat}`)
    }
  }
  return lines.join('\n')
}

export function filterCoverageRows (
  report: CoverageReport,
  options: {
    unsupported?: boolean
    unknown?: boolean
    primaryAi?: boolean
    consumerPrimary?: boolean
  }
): CoverageRow[] {
  let rows = report.rows
  if (options.unknown) {
    rows = rows.filter((r) => r.category === 'unknown')
  }
  if (options.primaryAi) {
    rows = rows.filter((r) => r.category === 'primary-ai')
  }
  if (options.consumerPrimary) {
    rows = rows.filter((r) => r.consumerPrimary)
  }
  if (options.unsupported) {
    rows = rows.filter((r) => !r.implemented)
  }
  return rows
}
