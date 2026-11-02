#!/usr/bin/env node
/**
 * The catalog against the SDK wire contract (packages/sdk/contract/schema.json), which
 * is what every client is generated from or checked against. The catalog declares the
 * wire shapes it uses in catalog/wire-types.ts instead of importing them from a client,
 * so this is where they are held to the contract:
 *
 * - the value lists there match the contract's enums exactly;
 * - every `toolDialect` a test's params or steps set, and every vector-index `storage`,
 *   is one of them;
 * - every decision test's request validates against `decide.request`, and the
 *   deliberately invalid one does not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const contractPath = path.resolve(root, '..', 'sdk', 'contract', 'schema.json')
const definitionsPath = path.join(root, 'dist', 'catalog', 'test-definitions.js')
const wireTypesPath = path.join(root, 'dist', 'catalog', 'wire-types.js')

for (const file of [definitionsPath, wireTypesPath]) {
  if (!fs.existsSync(file)) {
    console.error(
      `❌ ${path.relative(root, file)} is missing — run \`npm run build:catalog\` first.`
    )
    process.exit(1)
  }
}

const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
const { tests } = await import(pathToFileURL(definitionsPath).href)
const { TOOL_DIALECTS, VECTOR_INDEX_STORAGES } = await import(pathToFileURL(wireTypesPath).href)
const problems = []

const sameSet = (a, b) => a.length === b.length && a.every((value) => b.includes(value))

// Every request and response carrying a `toolDialect` has to agree on its values, or
// "the contract's enum" would mean whichever one was read first.
const dialectEnums = []
const collectDialects = (node) => {
  if (Array.isArray(node)) return node.forEach(collectDialects)
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'toolDialect' && Array.isArray(value?.enum)) dialectEnums.push(value.enum)
    collectDialects(value)
  }
}
collectDialects(contract.$defs)
const contractDialects = dialectEnums[0] ?? []
if (dialectEnums.length === 0) problems.push('the contract declares no toolDialect enum')
if (!dialectEnums.every((values) => sameSet(values, contractDialects))) {
  problems.push('the contract declares toolDialect with different values in different requests')
}
if (!sameSet([...TOOL_DIALECTS], contractDialects)) {
  problems.push(
    `TOOL_DIALECTS is [${TOOL_DIALECTS}], the contract's toolDialect is [${contractDialects}]`
  )
}

const contractStorages = contract.$defs['constants.VectorIndexStorage']?.enum ?? []
if (!sameSet([...VECTOR_INDEX_STORAGES], contractStorages)) {
  problems.push(
    `VECTOR_INDEX_STORAGES is [${VECTOR_INDEX_STORAGES}], the contract's VectorIndexStorage is [${contractStorages}]`
  )
}

// A `$params.*` string is a reference a step resolves at run time, not a value.
const literal = (value) => typeof value === 'string' && !value.startsWith('$')

const visit = (node, onEntry) => {
  if (Array.isArray(node)) return node.forEach((child) => visit(child, onEntry))
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    onEntry(key, value)
    visit(value, onEntry)
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true })
ajv.addSchema(contract, 'contract')
const validateDecide = ajv.getSchema('contract#/$defs/decide.request')
if (!validateDecide) {
  console.error(`❌ ${path.relative(root, contractPath)} has no decide.request`)
  process.exit(1)
}
const asRequest = (params) => ({ ...params, type: 'decide', modelId: 'catalog' })
const errorsOf = () => ajv.errorsText(validateDecide.errors, { separator: '; ' })

let dialects = 0
let storages = 0
let decisions = 0
for (const test of tests) {
  visit([test.params, test.steps], (key, value) => {
    if (key !== 'toolDialect' || !literal(value)) return
    dialects++
    if (!contractDialects.includes(value)) {
      problems.push(`${test.testId}: toolDialect "${value}" is not in the contract`)
    }
  })

  // VectorIndexParams.storage; no other params use the key.
  if (literal(test.params?.storage)) {
    storages++
    if (!contractStorages.includes(test.params.storage)) {
      problems.push(`${test.testId}: storage "${test.params.storage}" is not in the contract`)
    }
  }

  if (test.metadata?.category !== 'decision') continue
  decisions++
  const { params } = test
  if (params?.questions) {
    if (!validateDecide(asRequest(params))) {
      problems.push(`${test.testId}: not a valid decide.request: ${errorsOf()}`)
    }
  } else if (params?.invalid && params?.recovery) {
    if (validateDecide(asRequest(params.invalid))) {
      problems.push(`${test.testId}: params.invalid is a valid decide.request, so it tests nothing`)
    }
    if (!validateDecide(asRequest(params.recovery))) {
      problems.push(`${test.testId}: params.recovery is not a valid decide.request: ${errorsOf()}`)
    }
  } else {
    problems.push(`${test.testId}: a decision test of a shape this check does not know`)
  }
}

if (problems.length > 0) {
  console.error('❌ The catalog does not match the SDK wire contract:')
  for (const problem of problems) console.error(`   ${problem}`)
  process.exit(1)
}
console.log(
  `✅ The catalog matches the SDK wire contract (${dialects} tool dialects, ${storages} index storages, ${decisions} decision tests)`
)
