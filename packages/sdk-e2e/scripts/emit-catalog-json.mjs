#!/usr/bin/env node
/**
 * Writes the catalog, platform skips applied, as JSON for a client that carries its own copy of the
 * definitions (the Kotlin Android app).
 *
 * `expectation.fn` closures are dropped; the definition keeps `validation: 'function'`, which a
 * client reports as incomplete. Any other non-JSON value fails here.
 *
 *   node scripts/emit-catalog-json.mjs --out <directory>
 *
 * Reads dist/catalog: run `npm run build:catalog` first, or `npm run emit:catalog-json` for both.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const definitionsPath = path.join(root, 'dist', 'catalog', 'test-definitions.js')

const outFlag = process.argv.indexOf('--out')
if (outFlag === -1 || !process.argv[outFlag + 1]) {
  console.error('usage: emit-catalog-json.mjs --out <directory>')
  process.exit(2)
}
const outDir = path.resolve(process.argv[outFlag + 1])

if (!fs.existsSync(definitionsPath)) {
  console.error(
    `❌ ${path.relative(root, definitionsPath)} is missing — run \`npm run build:catalog\` first.`
  )
  process.exit(1)
}

const { tests } = await import(pathToFileURL(definitionsPath).href)
const problems = []

// Plain JSON plus `expectation.fn`; anything else is reported with its path in the definition.
function toJson(value, where) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) problems.push(`${where}: ${value} is not a JSON number`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => toJson(item, `${where}[${index}]`))
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (typeof item === 'function' && key === 'fn' && where.endsWith('.expectation')) continue
      out[key] = toJson(item, `${where}.${key}`)
    }
    return out
  }
  problems.push(`${where}: ${Object.prototype.toString.call(value)} cannot be written as JSON`)
  return null
}

const definitions = tests.map((test) => toJson(test, test.testId ?? '<no testId>'))

if (problems.length > 0) {
  console.error('❌ The catalog has values a JSON client cannot read:')
  for (const problem of problems) console.error(`   ${problem}`)
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'test-definitions.json')
fs.writeFileSync(outPath, `${JSON.stringify(definitions)}\n`)
const closures = definitions.filter((test) => test.expectation?.validation === 'function').length
console.log(
  `✅ wrote ${definitions.length} definitions to ${outPath}` +
    ` (${closures} use a JS closure and run as incomplete on a JSON client)`
)
