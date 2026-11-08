#!/usr/bin/env bun
/**
 * Report every public SDK request field the contract leaves undescribed.
 *
 * Usage: bun run scripts/api-reference/report-sdk-descriptions.ts
 *
 * A field is public when a client function's request carries it, wire-only
 * fields aside. Its description comes from the Zod schema's `.describe()`,
 * which lives in `packages/inference`. The report never fails: it lists what
 * is missing so the owners can complete it.
 */
import * as path from 'node:path'
import { functionNames, functionReference, loadLineApi, type LineApi } from '../../src/lib/api-reference/data'
import type { Shape } from '../../src/lib/api-reference/schema'
import { declaredSoftware } from '../../src/lib/versions'

function undescribed(shape: Shape, prefix: string, found: Set<string>): void {
  const objects = shape.kind === 'object' ? [shape] : shape.variants.map((variant) => variant.shape)
  for (const object of objects) {
    for (const field of object.fields) {
      const name = prefix ? `${prefix}.${field.name}` : field.name
      if (!field.description) found.add(name)
      if (field.shape) undescribed(field.shape, name, found)
    }
  }
}

export function undescribedFields(api: LineApi): Map<string, string[]> {
  const report = new Map<string, string[]>()
  for (const name of functionNames(api)) {
    const request = functionReference(api, name)?.request
    if (!request) continue
    const found = new Set<string>()
    undescribed(request, '', found)
    if (found.size > 0) report.set(name, [...found].sort())
  }
  return report
}

if (import.meta.main) {
  const monorepo = path.resolve(import.meta.dirname, '..', '..', '..', '..')
  const sdk = declaredSoftware().find((entry) => entry.declaration.path === '/sdk')!.declaration
  const api = loadLineApi(monorepo, sdk.paths, '/sdk')
  if (!api) {
    console.error('No SDK contract or generated surface data in the working tree.')
    process.exit(0)
  }
  const report = undescribedFields(api)
  const total = [...report.values()].reduce((sum, fields) => sum + fields.length, 0)
  for (const [fn, fields] of report) console.log(`${fn}: ${fields.join(', ')}`)
  console.log(`\n${total} public request field(s) without a description, across ${report.size} function(s)`)
}
