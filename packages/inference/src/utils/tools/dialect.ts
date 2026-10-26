import type { ToolDialect } from '@/schemas/index'
import { readGgufArchitecture } from '@/utils/gguf-architecture'

/**
 * The tool-call dialect a model's registry name or file name points to, or
 * undefined when neither matches a known pattern.
 */
export function matchToolDialectFromName(
  name: string | undefined,
  path: string
): ToolDialect | undefined {
  const basename = path.toLowerCase().split(/[/\\]/).pop() ?? ''
  const tag = `${(name ?? '').toLowerCase()}|${basename}`

  if (/qwen3[._-]?[568](?![a-z0-9])/.test(tag)) return 'qwen35'
  if (/gemma[-_]?4(?=[^a-z0-9]|$)/.test(tag)) return 'gemma4'
  if (/gpt[_-]?oss/.test(tag)) return 'harmony'
  if (/deepseek[-_. ]?v(?:4|3[._-]?2)(?![0-9])/.test(tag)) return 'dsml'
  if (/lfm[_-]?\d/.test(tag)) return 'pythonic'
  return undefined
}

const ARCHITECTURE_DIALECTS = new Map<string, ToolDialect>([
  ['qwen35', 'qwen35'],
  ['qwen35moe', 'qwen35'],
  ['qwen4exp', 'qwen35'],
  ['gemma4', 'gemma4'],
  ['gpt-oss', 'harmony'],
  ['deepseek32', 'dsml'],
  ['deepseek4', 'dsml'],
  ['lfm2', 'pythonic'],
  ['lfm2moe', 'pythonic']
])

/**
 * The tool-call dialect for a GGUF `general.architecture` value, or undefined
 * for an architecture whose models use the default dialect.
 */
export function matchToolDialectFromArchitecture(
  architecture: string | undefined
): ToolDialect | undefined {
  return architecture === undefined ? undefined : ARCHITECTURE_DIALECTS.get(architecture)
}

/**
 * Resolves a model's tool-call dialect: its name first, then the
 * `general.architecture` in its GGUF header, then "hermes", whose parser chain
 * also covers unknown JSON-payload models. The header is read only when the
 * name does not match. Bypass with `completion({ toolDialect })`.
 */
export async function resolveToolDialect(
  name: string | undefined,
  path: string
): Promise<ToolDialect> {
  return (
    matchToolDialectFromName(name, path) ??
    matchToolDialectFromArchitecture(await readGgufArchitecture(path)) ??
    'hermes'
  )
}
