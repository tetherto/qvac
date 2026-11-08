/**
 * The projected public surface of a documented software: one entry per
 * symbol a page can bind, each the normalized facts a reader relies on.
 *
 * A projection holds what a page's prose can go stale against — signatures,
 * expanded types, field descriptions, options — and nothing else. It is read
 * from the same data the reference renders from, so a file move or an
 * implementation change leaves it untouched, and a change to a type the
 * symbol only reaches through a reference still changes it.
 *
 * Which symbols exist follows from the data the software ships, not from its
 * name: a contract gives `fn:` symbols, a command model `command:` symbols,
 * an OpenAPI document `endpoint:` symbols. `surface` stands for all of them,
 * for software that binds its surface as a whole.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { commandsOf, openApiOperations, type CliCommand, type CliData } from '../../src/lib/api-reference/cli'
import { functionReference, loadLineApi } from '../../src/lib/api-reference/data'
import { SchemaReader, type JsonSchema } from '../../src/lib/api-reference/schema'

export const WHOLE_SURFACE = 'surface'

export type Surface = Map<string, unknown>

export interface SurfaceSource {
  /** A tree laid out like the repository, holding the software's `paths`. */
  root: string
  /** The software's declared paths, the documentation root first. */
  paths: readonly string[]
}

/** Every bindable symbol of a software, with its projection. */
export function projectSurface({ root, paths }: SurfaceSource): Surface {
  const surface: Surface = new Map()
  for (const [id, projection] of functionSymbols(root, paths)) surface.set(id, projection)
  const generated = path.join(root, paths[0], '_generated')
  const cli = readJson<CliData>(path.join(generated, 'cli.json'))
  if (cli) for (const [id, projection] of commandSymbols(cli)) surface.set(id, projection)
  const openapi = readJson<Record<string, unknown>>(path.join(generated, 'openapi.json'))
  if (openapi) for (const [id, projection] of endpointSymbols(openapi)) surface.set(id, projection)
  return surface
}

/** The hash a lock records for one symbol, or for the whole surface. */
export function surfaceHash(surface: Surface, id: string): string | null {
  if (id === WHOLE_SURFACE) {
    const entries = [...surface.entries()].sort(([a], [b]) => a.localeCompare(b))
    return digest(entries)
  }
  return surface.has(id) ? digest(surface.get(id)) : null
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16)
}

/** JSON with sorted keys and collapsed whitespace in strings, so layout never counts. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  if (typeof value === 'string') return JSON.stringify(value.replace(/\s+/g, ' ').trim())
  return JSON.stringify(value ?? null)
}

function* functionSymbols(root: string, paths: readonly string[]): Generator<[string, unknown]> {
  const api = loadLineApi(root, paths, '')
  if (!api) return
  for (const { name } of api.js) {
    const reference = functionReference(api, name)
    if (!reference) continue
    yield [
      `fn:${name}`,
      {
        description: reference.description,
        js: reference.jsSignature,
        python: reference.pythonSignature,
        request: reference.requestSchema ? expand(api.schema, reference.requestSchema) : null,
        response: reference.responseSchema ? expand(api.schema, reference.responseSchema) : null,
        returns: reference.returns,
        returnFields: reference.returnFields,
        throws: reference.throws,
        deprecated: reference.deprecated,
      },
    ]
  }
}

function* commandSymbols(cli: CliData): Generator<[string, unknown]> {
  yield [`command:${cli.name}`, { description: cli.description, options: cli.options }]
  for (const command of commandsOf(cli)) yield [`command:${command.path}`, commandProjection(command)]
}

/** A command without its subcommands, which are symbols of their own. */
function commandProjection({ commands: _commands, ...command }: CliCommand): unknown {
  return command
}

function* endpointSymbols(document: Record<string, unknown>): Generator<[string, unknown]> {
  const { reader, operations } = openApiOperations(document)
  for (const operation of operations) {
    yield [`endpoint:${operation.method.toUpperCase()} ${operation.path}`, expand(reader, operation)]
  }
}

/** Inlines every reference, so a change to a reached type changes the symbol. */
export function expand(reader: SchemaReader, value: unknown, seen: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((entry) => expand(reader, entry, seen))
  if (!value || typeof value !== 'object') return value
  const node = value as JsonSchema
  if (typeof node.$ref === 'string') {
    const name = decodeURIComponent(node.$ref.replace(/^#\/(\$defs|components\/schemas)\//, ''))
    if (seen.has(name)) return { $ref: node.$ref }
    const { $ref: _ref, ...rest } = node
    return expand(reader, { ...(reader.definition(name) ?? {}), ...rest }, new Set([...seen, name]))
  }
  return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, expand(reader, entry, seen)]))
}

function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf-8')) as T) : null
}
