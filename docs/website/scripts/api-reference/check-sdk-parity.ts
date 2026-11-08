#!/usr/bin/env bun
/**
 * Check that every SDK contract method is reachable from every published
 * language.
 *
 * Usage: bun run scripts/api-reference/check-sdk-parity.ts
 *
 * A method is reachable in JavaScript when a public client function calls it
 * (`src/lib/api-reference/client-map.ts`), and in Python when a public
 * function carries its snake_case name. Reads the working tree's contract and
 * generated surface data (`npm run docs:sdk-api`). Exits 1 naming each method
 * and language that does not reach it.
 */
import * as path from 'node:path'
import { contractTargetOf } from '../../src/lib/api-reference/client-map'
import { loadLineApi, type LineApi } from '../../src/lib/api-reference/data'
import { toSnakeCase } from '../../src/lib/api-reference/names'
import { declaredSoftware } from '../../src/lib/versions'

/** Methods the clients reach only through another call, and why. */
export const NOT_CALLED_DIRECTLY: Readonly<Record<string, string>> = {}

export function parityGaps(api: LineApi): string[] {
  const methods = new Set(api.methods.keys())
  const reachedByJs = new Set(
    api.js.map((fn) => contractTargetOf(fn.name, methods)?.method).filter((method): method is string => Boolean(method)),
  )
  const python = new Set(api.python.map((fn) => fn.name))
  const gaps: string[] = []
  for (const method of methods) {
    if (NOT_CALLED_DIRECTLY[method]) continue
    if (!reachedByJs.has(method)) gaps.push(`${method}: no JavaScript function calls it`)
    if (!python.has(toSnakeCase(method))) gaps.push(`${method}: no Python function \`${toSnakeCase(method)}\``)
  }
  return gaps
}

if (import.meta.main) {
  const monorepo = path.resolve(import.meta.dirname, '..', '..', '..', '..')
  const sdk = declaredSoftware().find((entry) => entry.declaration.path === '/sdk')!.declaration
  const api = loadLineApi(monorepo, sdk.paths, '/sdk')
  if (!api) {
    console.error('No SDK contract or generated surface data in the working tree.')
    process.exit(1)
  }
  const gaps = parityGaps(api)
  if (gaps.length > 0) {
    console.error(`SDK language parity: ${gaps.length} gap(s)\n  ${gaps.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`SDK language parity: all ${api.methods.size} contract methods reachable from JavaScript and Python`)
}
