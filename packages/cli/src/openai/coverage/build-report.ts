import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { categorize, summarizeUnknownLabels } from './categorize.js'
import { parseRouter } from './parse-router.js'
import { parseSpec } from './parse-spec.js'
import { CONSUMER_PRIMARY_ENDPOINTS } from './primary.js'
import type {
  CategorySummary,
  CoverageCategory,
  CoverageReport,
  CoverageRow,
  CoverageSummary,
  SpecEntry
} from './types.js'

const COVERAGE_DIR = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = join(COVERAGE_DIR, '..', '..', '..')
const DEFAULT_ROUTER = join(CLI_ROOT, 'src', 'serve', 'routes')

function percent (n: number, total: number): number {
  if (total === 0) return 0
  return Math.round((n / total) * 1000) / 10
}

function summarizeCategory (
  rows: CoverageRow[],
  category: CoverageCategory
): CategorySummary {
  const subset = rows.filter((r) => r.category === category)
  const implemented = subset.filter((r) => r.implemented).length
  return {
    implemented,
    total: subset.length,
    percent: percent(implemented, subset.length)
  }
}

function summarizeRows (rows: CoverageRow[]): CoverageSummary {
  const categories: CoverageCategory[] = [
    'primary-ai',
    'ai-secondary',
    'platform',
    'unknown'
  ]
  const byCategory = {} as Record<CoverageCategory, CategorySummary>
  for (const cat of categories) {
    byCategory[cat] = summarizeCategory(rows, cat)
  }

  const consumerRows = rows.filter((r) => r.consumerPrimary)
  const consumerImplemented = consumerRows.filter((r) => r.implemented).length
  const fullImplemented = rows.filter((r) => r.implemented).length

  const summary: CoverageSummary = {
    byCategory,
    consumerPrimary: {
      implemented: consumerImplemented,
      total: consumerRows.length,
      percent: percent(consumerImplemented, consumerRows.length)
    },
    full: {
      implemented: fullImplemented,
      total: rows.length,
      percent: percent(fullImplemented, rows.length)
    }
  }

  if (byCategory.unknown.total > 0) {
    const unknownEntries = rows
      .filter((r) => r.category === 'unknown')
      .map((r) => {
        const entry: Pick<SpecEntry, 'tags' | 'group'> = {
          tags: r.tags
        }
        if (r.group !== undefined) entry.group = r.group
        return entry
      })
    summary.unknownBreakdown = summarizeUnknownLabels(unknownEntries)
  }

  return summary
}

export async function buildCoverageReport (options: {
  offline?: boolean
  specPath?: string
  routerPath?: string
} = {}): Promise<CoverageReport> {
  const routerPath = options.routerPath ?? DEFAULT_ROUTER
  const parseOpts: Parameters<typeof parseSpec>[0] = {}
  if (options.offline) parseOpts.offline = true
  if (options.specPath) parseOpts.specPath = options.specPath
  const { entries: specEntries, source: specSource } = await parseSpec(parseOpts)
  const implementedList = parseRouter(routerPath)
  const implemented = new Set(implementedList)

  const specKeys = new Set(specEntries.map((e) => `${e.method} ${e.path}`))
  for (const key of implemented) {
    if (!specKeys.has(key)) {
      throw new Error(
        `Router implements ${key} but it is not present in the OpenAPI spec`
      )
    }
  }

  const rows: CoverageRow[] = specEntries.map((e) => {
    const key = `${e.method} ${e.path}`
    const category = categorize(e)
    const row: CoverageRow = {
      method: e.method,
      path: e.path,
      key,
      category,
      consumerPrimary: CONSUMER_PRIMARY_ENDPOINTS.has(key),
      implemented: implemented.has(key),
      deprecated: e.deprecated ?? false,
      tags: e.tags
    }
    if (e.group !== undefined) row.group = e.group
    return row
  })

  return {
    fetchedAt: new Date().toISOString(),
    specSource,
    routerSource: routerPath,
    implementedCount: implementedList.length,
    rows,
    summary: summarizeRows(rows)
  }
}
