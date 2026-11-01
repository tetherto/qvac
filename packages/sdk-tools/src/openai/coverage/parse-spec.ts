import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'
import type { CoverageSpecSourceMode, HttpMethod, SpecEntry } from '@/openai/coverage/types'

const SPEC_URL = 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml'

const CACHE_DIR = join(homedir(), '.cache', 'qvac')
const FETCH_TIMEOUT_MS = 15_000

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch'])

export interface ParseSpecDependencies {
  cacheDir: string
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  timeoutMs: number
}

export interface ParsedSpec {
  entries: SpecEntry[]
  source: string
  sourceMode: CoverageSpecSourceMode
  sha256: string
}

function cachePaths(cacheDir: string) {
  return {
    spec: join(cacheDir, 'openai-spec.yaml'),
    etag: join(cacheDir, 'openai-spec.etag'),
    sha256: join(cacheDir, 'openai-spec.sha256')
  }
}

function sha256(yaml: string): string {
  return createHash('sha256').update(yaml, 'utf8').digest('hex')
}

function validateCachedSpecHash(yaml: string, hashPath: string, required: boolean): void {
  if (!existsSync(hashPath)) {
    if (required) {
      throw new Error('cached OpenAI specification SHA-256 is missing')
    }
    return
  }
  const expectedSha256 = readFileSync(hashPath, 'utf8').trim()
  if (!expectedSha256 || sha256(yaml) !== expectedSha256) {
    throw new Error('cached OpenAI specification hash mismatch')
  }
}

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

  if (entries.length === 0) {
    throw new Error('OpenAI specification contains no supported HTTP operations')
  }

  return entries.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path)
    if (pathCmp !== 0) return pathCmp
    return a.method.localeCompare(b.method)
  })
}

function writeFileAtomically(path: string, content: string): void {
  const cacheDir = dirname(path)
  mkdirSync(cacheDir, { recursive: true })
  const tempDir = mkdtempSync(join(cacheDir, '.openai-spec-'))
  const tempPath = join(tempDir, 'payload')
  try {
    writeFileSync(tempPath, content, 'utf8')
    renameSync(tempPath, path)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function fetchSpecLive(dependencies: ParseSpecDependencies): Promise<{
  yaml: string
  entries: SpecEntry[]
  source: string
  sourceMode: CoverageSpecSourceMode
}> {
  mkdirSync(dependencies.cacheDir, { recursive: true })
  const paths = cachePaths(dependencies.cacheDir)
  const headers: Record<string, string> = {}
  try {
    const etag = readFileSync(paths.etag, 'utf8').trim()
    if (etag) headers['If-None-Match'] = etag
  } catch {
    // no cached etag
  }

  let res = await dependencies.fetch(SPEC_URL, {
    headers,
    signal: AbortSignal.timeout(dependencies.timeoutMs)
  })
  if (res.status === 304) {
    try {
      const yaml = readFileSync(paths.spec, 'utf8')
      validateCachedSpecHash(yaml, paths.sha256, true)
      return {
        yaml,
        entries: parseSpecYaml(yaml),
        source: `${SPEC_URL} (cached, not modified)`,
        sourceMode: 'live-validated-cache'
      }
    } catch {
      res = await dependencies.fetch(SPEC_URL, {
        headers: {},
        signal: AbortSignal.timeout(dependencies.timeoutMs)
      })
    }
  }
  if (res.status === 304) {
    throw new Error('OpenAI specification returned HTTP 304 without a valid cache')
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenAI spec: HTTP ${res.status}`)
  }
  const yaml = await res.text()
  const entries = parseSpecYaml(yaml)
  writeFileAtomically(paths.spec, yaml)
  writeFileAtomically(paths.sha256, sha256(yaml))
  const newEtag = res.headers.get('etag')
  if (newEtag) {
    writeFileAtomically(paths.etag, newEtag)
  } else {
    rmSync(paths.etag, { force: true })
  }
  return { yaml, entries, source: SPEC_URL, sourceMode: 'live' }
}

export async function parseSpecWithDependencies(
  options: {
    offline?: boolean
    specPath?: string
  },
  dependencies: ParseSpecDependencies
): Promise<ParsedSpec> {
  if (options.specPath) {
    const yaml = readFileSync(options.specPath, 'utf8')
    return {
      entries: parseSpecYaml(yaml),
      source: options.specPath,
      sourceMode: 'file',
      sha256: sha256(yaml)
    }
  }

  const paths = cachePaths(dependencies.cacheDir)
  if (options.offline) {
    try {
      const yaml = readFileSync(paths.spec, 'utf8')
      validateCachedSpecHash(yaml, paths.sha256, false)
      return {
        entries: parseSpecYaml(yaml),
        source: `${paths.spec} (offline cache)`,
        sourceMode: 'offline-cache',
        sha256: sha256(yaml)
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Offline mode requires a valid cached spec at ${paths.spec}: ${detail}. Run without --offline once to populate the cache.`,
        { cause: error }
      )
    }
  }

  const { yaml, entries, source, sourceMode } = await fetchSpecLive(dependencies)
  return { entries, source, sourceMode, sha256: sha256(yaml) }
}

export function parseSpec(
  options: {
    offline?: boolean
    specPath?: string
  } = {}
): Promise<ParsedSpec> {
  return parseSpecWithDependencies(options, {
    cacheDir: CACHE_DIR,
    fetch: globalThis.fetch,
    timeoutMs: FETCH_TIMEOUT_MS
  })
}
