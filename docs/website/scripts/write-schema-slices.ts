#!/usr/bin/env bun
/**
 * Publish each function's JSON Schema slice beside its reference page.
 *
 * Usage (after `next build`): bun run scripts/write-schema-slices.ts
 *
 * For every documentation line with API data (a line materialized from its
 * commit, or the unreleased `preview`), writes
 * `out/<line base>/reference/api/<fn>.schema.json`: the request and response
 * schema of the contract method the function calls, with every `$ref`
 * inlined, so an agent can fetch one method without the whole contract.
 * Nothing is written to the repository.
 */
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { functionNames, functionReference, lineApiForUrl, type LineApi } from '../src/lib/api-reference/data'
import type { JsonSchema, SchemaReader } from '../src/lib/api-reference/schema'
import { DOCUMENTED_SOFTWARE } from '../src/lib/versions'

const WEBSITE_ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(WEBSITE_ROOT, 'out')

/** A schema with every `$ref` replaced by its definition; a cycle stays a `$ref`. */
export function inline(reader: SchemaReader, schema: unknown, seen: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => inline(reader, entry, seen))
  if (!schema || typeof schema !== 'object') return schema
  const node = schema as JsonSchema
  if (node.$ref) {
    const name = decodeURIComponent(node.$ref.replace(/^#\/\$defs\//, ''))
    if (seen.has(name)) return node
    const { $ref: _ref, ...rest } = node
    return inline(reader, { ...(reader.definition(name) ?? {}), ...rest }, new Set([...seen, name]))
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inline(reader, value, seen)]))
}

function lineBases(): string[] {
  const bases: string[] = []
  for (const software of DOCUMENTED_SOFTWARE) {
    for (const version of software.versions) {
      bases.push(version.folder.startsWith('(') ? software.path : `${software.path}/${version.version}`)
    }
    if (existsSync(path.join(WEBSITE_ROOT, 'content', 'docs', software.path.slice(1), 'preview', '.materialized'))) {
      bases.push(`${software.path}/preview`)
    }
  }
  return bases
}

async function writeSlices(api: LineApi): Promise<number> {
  let written = 0
  for (const name of functionNames(api)) {
    const reference = functionReference(api, name)
    if (!reference?.target || !reference.requestSchema) continue
    const slice = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      function: name,
      method: reference.target.method,
      variant: reference.target.variant ?? null,
      request: inline(api.schema, reference.requestSchema),
      response: inline(api.schema, reference.responseSchema),
    }
    const target = path.join(OUT, api.base, 'reference', 'api', `${name}.schema.json`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify(slice, null, 2) + '\n')
    written++
  }
  return written
}

if (import.meta.main) {
  if (!existsSync(OUT)) {
    console.error('No out/. Run `next build` first.')
    process.exit(1)
  }
  let total = 0
  for (const base of lineBases()) {
    const api = lineApiForUrl(base)
    if (api) total += await writeSlices(api)
  }
  console.log(`Wrote ${total} schema slice(s)`)
}
