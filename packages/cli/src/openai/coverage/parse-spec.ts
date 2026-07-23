import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import type { HttpMethod, SpecEntry } from './types.js'

const SPEC_URL = 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml'

const CACHE_DIR = join(homedir(), '.cache', 'qvac')
const CACHE_SPEC = join(CACHE_DIR, 'openai-spec.yaml')
const CACHE_ETAG = join(CACHE_DIR, 'openai-spec.etag')

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch'])

function normalizePath(rawPath: string): string {
  if (rawPath.startsWith('/v1/')) return rawPath
  if (rawPath.startsWith('/')) return `/v1${rawPath}`
  return `/v1/${rawPath}`
}

function parseSpecYaml(yamlText: string): SpecEntry[] {
  const doc = load(yamlText) as {
    paths?: Record<string, Record<string, unknown>>
  }
  const paths = doc.paths ?? {}
  const entries: SpecEntry[] = []

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue
    for (const [methodLower, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(methodLower)) continue
      if (!operation || typeof operation !== 'object') continue
      const op = operation as Record<string, unknown>
      const tags = Array.isArray(op['tags'])
        ? op['tags'].filter((t): t is string => typeof t === 'string')
        : []
      const xoai = op['x-oaiMeta'] as { group?: string } | undefined
      const group = typeof xoai?.group === 'string' ? xoai.group : undefined
      const operationId = typeof op['operationId'] === 'string' ? op['operationId'] : undefined
      const deprecated = op['deprecated'] === true
      const entry: SpecEntry = {
        method: methodLower.toUpperCase() as HttpMethod,
        path: normalizePath(rawPath),
        tags,
        deprecated
      }
      if (group !== undefined) entry.group = group
      if (operationId !== undefined) entry.operationId = operationId
      entries.push(entry)
    }
  }

  return entries.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path)
    if (pathCmp !== 0) return pathCmp
    return a.method.localeCompare(b.method)
  })
}

async function fetchSpecLive(): Promise<{ yaml: string; source: string }> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const headers: Record<string, string> = {}
  try {
    const etag = readFileSync(CACHE_ETAG, 'utf8').trim()
    if (etag) headers['If-None-Match'] = etag
  } catch {
    // no cached etag
  }

  const res = await fetch(SPEC_URL, { headers })
  if (res.status === 304) {
    return {
      yaml: readFileSync(CACHE_SPEC, 'utf8'),
      source: `${SPEC_URL} (cached, not modified)`
    }
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenAI spec: HTTP ${res.status}`)
  }
  const yaml = await res.text()
  writeFileSync(CACHE_SPEC, yaml, 'utf8')
  const newEtag = res.headers.get('etag')
  if (newEtag) writeFileSync(CACHE_ETAG, newEtag, 'utf8')
  return { yaml, source: SPEC_URL }
}

export async function parseSpec(
  options: {
    offline?: boolean
    specPath?: string
  } = {}
): Promise<{ entries: SpecEntry[]; source: string }> {
  if (options.specPath) {
    const yaml = readFileSync(options.specPath, 'utf8')
    return {
      entries: parseSpecYaml(yaml),
      source: options.specPath
    }
  }

  if (options.offline) {
    try {
      const yaml = readFileSync(CACHE_SPEC, 'utf8')
      return {
        entries: parseSpecYaml(yaml),
        source: `${CACHE_SPEC} (offline cache)`
      }
    } catch {
      throw new Error(
        `Offline mode requires a cached spec at ${CACHE_SPEC}. Run without --offline once to populate the cache.`
      )
    }
  }

  const { yaml, source } = await fetchSpecLive()
  return { entries: parseSpecYaml(yaml), source }
}
