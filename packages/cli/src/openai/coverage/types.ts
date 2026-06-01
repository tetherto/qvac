export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

export type CoverageCategory = 'primary-ai' | 'ai-secondary' | 'platform' | 'unknown'

export interface SpecEntry {
  method: HttpMethod
  path: string
  tags: string[]
  group?: string
  operationId?: string
  deprecated?: boolean
}

export interface CoverageRow {
  method: HttpMethod
  path: string
  key: string
  category: CoverageCategory
  consumerPrimary: boolean
  implemented: boolean
  deprecated: boolean
  tags: string[]
  group?: string
}

export interface CategorySummary {
  implemented: number
  total: number
  percent: number
}

export interface UnknownLabelCount {
  label: string
  kind: 'tag' | 'group'
  count: number
}

export interface CoverageSummary {
  byCategory: Record<CoverageCategory, CategorySummary>
  consumerPrimary: CategorySummary
  full: CategorySummary
  /** Present when any operation remains in the unknown category. */
  unknownBreakdown?: UnknownLabelCount[]
}

export interface CoverageReport {
  fetchedAt: string
  specSource: string
  routerSource: string
  implementedCount: number
  rows: CoverageRow[]
  summary: CoverageSummary
}
