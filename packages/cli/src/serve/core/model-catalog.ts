import type { ModelConstant } from '@qvac/sdk'
import { normalizeEndpointCategory } from '@/serve/config'
import type { ModelRegistry, ModelState, ServeConfig } from '@/serve/core/model-registry'

/** A discovery-listing row. Deliberately NOT an OpenAI `model` object: a
 * `not_configured` entry is browsable but not callable on this server. */
export interface ModelCatalogEntry {
  object: 'model_catalog_entry'
  id: string
  source: 'config' | 'builtin'
  configured: boolean
  /** Callable on this server right now or after a lazy-load — true iff configured. */
  usable: boolean
  state: ModelState | 'not_configured'
  role: string
  addon: string | null
  engine: string | null
  quantization: string | null
  params: string | null
  /** Expected on-disk size in bytes, when known (constant-backed models). */
  size: number | null
  hint?: string
}

export interface CatalogQuery {
  search?: string | undefined
  role?: string | undefined
  addon?: string | undefined
  quantization?: string | undefined
  engine?: string | undefined
  configured?: boolean | undefined
}

const CATALOG_HINT =
  'Not in serve.models — run `qvac configure` (or add it there by hand) to make it usable.'

export function roleForAddon(addon: string): string {
  return normalizeEndpointCategory(addon)
}

function metaFrom(modelSrc: string | ModelConstant, sdkType: string) {
  if (typeof modelSrc === 'string') {
    return { addon: null, engine: sdkType || null, quantization: null, params: null, size: null }
  }
  return {
    addon: modelSrc.addon ?? null,
    engine: modelSrc.engine ?? null,
    quantization: modelSrc.quantization || null,
    params: modelSrc.params || null,
    size: typeof modelSrc.expectedSize === 'number' ? modelSrc.expectedSize : null
  }
}

// Configured aliases (usable) + every baked-in SDK constant (discoverable but
// not usable until configured). Pure/in-process; no SDK RPCs.
export function buildCatalog(
  serveConfig: ServeConfig,
  registry: ModelRegistry,
  constants: Map<string, ModelConstant>
): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = []

  for (const [alias, entry] of serveConfig.models) {
    const meta = metaFrom(entry.modelSrc, entry.sdkType)
    entries.push({
      object: 'model_catalog_entry',
      id: alias,
      source: 'config',
      configured: true,
      usable: true,
      state: registry.getEntry(alias)?.state ?? registry.STATES.IDLE,
      role: entry.endpointCategory,
      addon: meta.addon,
      engine: meta.engine,
      quantization: meta.quantization,
      params: meta.params,
      size: meta.size
    })
  }

  entries.push(...buildBuiltinCatalog(constants))

  // Configured first, then builtin; each group by id for a stable, paginable order.
  entries.sort((a, b) =>
    a.source === b.source ? a.id.localeCompare(b.id) : a.source === 'config' ? -1 : 1
  )
  return entries
}

// The catalog rows for every baked-in SDK constant, independent of any server
// context — usable by CLI commands (e.g. `configure`) that have no ServeConfig.
export function buildBuiltinCatalog(constants: Map<string, ModelConstant>): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = []
  for (const [name, model] of constants) {
    entries.push({
      object: 'model_catalog_entry',
      id: name,
      source: 'builtin',
      configured: false,
      usable: false,
      state: 'not_configured',
      role: roleForAddon(model.addon),
      addon: model.addon ?? null,
      engine: model.engine ?? null,
      quantization: model.quantization || null,
      params: model.params || null,
      size: typeof model.expectedSize === 'number' ? model.expectedSize : null,
      hint: CATALOG_HINT
    })
  }
  return entries
}

export function filterCatalog(
  entries: ModelCatalogEntry[],
  query: CatalogQuery
): ModelCatalogEntry[] {
  const search = query.search?.toLowerCase()
  const quantization = query.quantization?.toLowerCase()
  return entries.filter((e) => {
    if (query.configured !== undefined && e.configured !== query.configured) return false
    if (query.role !== undefined && e.role !== query.role) return false
    if (query.addon !== undefined && e.addon !== query.addon) return false
    if (query.engine !== undefined && e.engine !== query.engine) return false
    if (quantization !== undefined && (e.quantization ?? '').toLowerCase() !== quantization) {
      return false
    }
    if (search !== undefined && !e.id.toLowerCase().includes(search)) return false
    return true
  })
}

// No default limit: an omitted `limit` returns every matching entry from
// `offset` onward. A limit is applied only when the caller asks for one.
export function paginate(
  entries: ModelCatalogEntry[],
  limit?: number,
  offset = 0
): { data: ModelCatalogEntry[]; hasMore: boolean } {
  const end = limit === undefined ? entries.length : offset + limit
  const data = entries.slice(offset, end)
  return { data, hasMore: end < entries.length }
}
