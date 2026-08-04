import type { SkillRequires, SkillSetup, SkillSetupRoute } from './manifest.ts'

export interface ParsedManifest {
  requires?: SkillRequires
  setup?: SkillSetup
}

export function parseManifestBlock(block: string, key = 'metadata'): ParsedManifest {
  const json = extractJsonBlock(block, key)
  if (!isObject(json) || !isObject(json.openclaw)) return {}
  const openclaw = json.openclaw
  const requires = readRequires(openclaw.requires)
  const setup = readSetup(openclaw.setup)
  return {
    ...(requires ? { requires } : {}),
    ...(setup ? { setup } : {})
  }
}

function extractJsonBlock(block: string, key: string): unknown {
  const at = block.indexOf(`${key}:`)
  if (at === -1) return null
  const rest = block.slice(at + key.length + 1)
  const start = rest.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < rest.length; i++) {
    const char = rest[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(rest.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

function readRequires(value: unknown): SkillRequires | undefined {
  if (!isObject(value)) return undefined
  const bins = readStringArray(value.bins)
  const minVersions = readBinMinVersions(value.binMinVersions)
  return bins || minVersions
    ? {
        ...(bins ? { bins } : {}),
        ...(minVersions ? { binMinVersions: minVersions } : {})
      }
    : undefined
}

function readBinMinVersions(value: unknown): SkillRequires['binMinVersions'] {
  if (!isObject(value)) return undefined
  const result: Record<string, { min: string; command?: string }> = {}
  for (const [bin, spec] of Object.entries(value)) {
    if (!isObject(spec) || typeof spec.min !== 'string') continue
    result[bin] = {
      min: spec.min,
      ...(typeof spec.command === 'string' ? { command: spec.command } : {})
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function readSetup(value: unknown): SkillSetup | undefined {
  if (!isObject(value)) return undefined
  const summary = typeof value.summary === 'string' ? value.summary : undefined
  const routes = readRoutes(value.routes)
  return summary || routes
    ? {
        ...(summary ? { summary } : {}),
        ...(routes ? { routes } : {})
      }
    : undefined
}

function readRoutes(value: unknown): SkillSetupRoute[] | undefined {
  if (!Array.isArray(value)) return undefined
  const kinds = new Set(['oauth', 'token', 'install', 'picker', 'instructions'])
  const routes: SkillSetupRoute[] = []
  for (const raw of value) {
    if (!isObject(raw) || typeof raw.label !== 'string') continue
    if (typeof raw.kind !== 'string' || !kinds.has(raw.kind)) continue
    routes.push({
      kind: raw.kind as SkillSetupRoute['kind'],
      label: raw.label,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(typeof raw.helpUrl === 'string' ? { helpUrl: raw.helpUrl } : {}),
      ...(readStringArray(raw.steps) ? { steps: readStringArray(raw.steps) } : {})
    })
  }
  return routes.length > 0 ? routes : undefined
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const filtered = value.filter((entry): entry is string => typeof entry === 'string')
  return filtered.length > 0 ? filtered : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
