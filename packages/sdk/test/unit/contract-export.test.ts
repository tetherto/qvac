import test from 'brittle'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  buildContract,
  callShapeByHandlerType,
  contractDir,
  renderContractFiles
} from '@/scripts/contract/build-contract'
import { methodShapes } from '@/server/rpc/method-shapes'
import { contractValidate } from './utils/contract-validator'

type JsonSchema = Record<string, unknown>

function isSchemaObject(node: unknown): node is JsonSchema {
  return node !== null && typeof node === 'object' && !Array.isArray(node)
}

/** Every object/enum schema node reachable from `node`, excluding pure `{}`
 * ("any") placeholders and const-only literals. Mirrors build-contract.ts's
 * own notion of "a node that should carry a title". */
function collectTitleableNodes(node: unknown, out: JsonSchema[]): void {
  if (!isSchemaObject(node)) return

  const arms = (node['oneOf'] ?? node['anyOf']) as unknown
  if (Array.isArray(arms)) {
    for (const arm of arms) collectTitleableNodes(arm, out)
    return
  }

  const isEnum = Array.isArray(node['enum'])
  const isObject = node['type'] === 'object' || isSchemaObject(node['properties'])
  const hasConst = node['const'] !== undefined
  if ((isEnum || isObject) && !hasConst) out.push(node)

  const properties = node['properties']
  if (isSchemaObject(properties)) {
    for (const propSchema of Object.values(properties)) collectTitleableNodes(propSchema, out)
  }
  if (node['items'] !== undefined) collectTitleableNodes(node['items'], out)
  if (isSchemaObject(node['additionalProperties'])) {
    collectTitleableNodes(node['additionalProperties'], out)
  }
}

test('manifest lists every method with its call shape', (t) => {
  const { manifest } = buildContract()
  const names = manifest.methods.map((method) => method.name)

  t.alike(names, Object.keys(methodShapes).sort(), 'one manifest entry per method, sorted')

  for (const method of manifest.methods) {
    t.is(
      method.callShape,
      callShapeByHandlerType[methodShapes[method.name]],
      `${method.name} call shape`
    )
  }
})

test('schema document has request and response defs for every method', (t) => {
  const { schemaDocument, manifest } = buildContract()
  const defs = schemaDocument.$defs

  for (const method of manifest.methods) {
    t.ok(defs[`${method.name}.request`], `${method.name}.request def`)
    t.ok(defs[`${method.name}.response`], `${method.name}.response def`)
  }

  const requestUnion = defs['request'] as { anyOf: Array<{ $ref: string }> }
  t.alike(
    requestUnion.anyOf.map((entry) => entry.$ref),
    manifest.methods.map((method) => `#/$defs/${method.name}.request`),
    'request union references every method request'
  )
})

test('schema defs carry unique titles for Python codegen class names', (t) => {
  // Without a `title`, JSON Schema -> Python codegen (e.g.
  // datamodel-code-generator) falls back to positional names like
  // `Request1Model11` for nested unions instead of `LoadModelRequest` —
  // verified against the actual generator, not assumed.
  const { schemaDocument, manifest } = buildContract()
  const defs = schemaDocument.$defs as Record<string, { title?: string }>

  const titles = new Set<string>()
  for (const [defName, def] of Object.entries(defs)) {
    t.ok(def.title, `${defName} has a title`)
    if (def.title) {
      t.ok(!titles.has(def.title), `${def.title} is unique (from ${defName})`)
      titles.add(def.title)
    }
  }

  for (const method of manifest.methods) {
    const pascalName = method.name.charAt(0).toUpperCase() + method.name.slice(1)
    t.is(defs[`${method.name}.request`]?.title, `${pascalName}Request`)
    t.is(defs[`${method.name}.response`]?.title, `${pascalName}Response`)
  }
})

test('every nested object/enum schema carries a title, not a positional name', (t) => {
  // Regression guard: without per-node titling, Python codegen produces
  // unlabeled positional class names for every untitled nested schema
  // (`Stats13`, `Events7`, `NeuralData1`) with no indication of what they
  // represent. Every def must be fully titled down to its leaves, and all
  // titles (top-level + nested) must be globally unique in one flat check.
  const { schemaDocument } = buildContract()
  const defs = schemaDocument.$defs as Record<string, JsonSchema>

  const allTitles = new Set<string>()
  for (const [defName, def] of Object.entries(defs)) {
    const nodes: JsonSchema[] = []
    collectTitleableNodes(def, nodes)
    for (const node of nodes) {
      const title = node['title']
      t.ok(typeof title === 'string' && title.length > 0, `untitled node under ${defName}`)
      if (typeof title === 'string') {
        t.ok(!allTitles.has(title), `title "${title}" (under ${defName}) is globally unique`)
        allTitles.add(title)
      }
    }
  }
})

test('cancel.request flattens allOf-of-union so both operations keep their fields', (t) => {
  // Regression test for a real bug found via datamodel-code-generator: Zod's
  // `.and()` of a plain object with a discriminated union exports as
  // `allOf: [commonFields, { oneOf: [...] }]`, which that generator does not
  // merge — it silently produced a `CancelRequest` class with only `type`,
  // dropping `operation`/`requestId`/`modelId` entirely. build-contract.ts
  // flattens this into a plain `oneOf` with the common fields merged in.
  const { schemaDocument } = buildContract()
  const def = (schemaDocument.$defs as Record<string, JsonSchema>)['cancel.request'] as JsonSchema

  t.absent(def['allOf'], 'allOf is flattened away')
  t.ok(Array.isArray(def['oneOf']), 'flattened into a oneOf')

  const targeted = { type: 'cancel', operation: 'request', requestId: 'req-1' }
  const broad = { type: 'cancel', operation: 'broad', modelId: 'model-1', kind: 'completion' }
  const missingOperationFields = { type: 'cancel', operation: 'request' } // requestId dropped

  t.ok(contractValidate('cancel.request', targeted).valid, 'targeted cancel keeps requestId')
  t.ok(contractValidate('cancel.request', broad).valid, 'broad cancel keeps modelId/kind')
  t.is(
    contractValidate('cancel.request', missingOperationFields).valid,
    false,
    'requestId is still required for a targeted cancel'
  )
})

test('export is deterministic across runs', async (t) => {
  const first = await renderContractFiles()
  const second = await renderContractFiles()

  t.is(first['schema.json'], second['schema.json'])
  t.is(first['manifest.json'], second['manifest.json'])
})

test('committed artifacts are up to date', async (t) => {
  const rendered = await renderContractFiles()

  for (const [name, content] of Object.entries(rendered)) {
    const committed = await readFile(fileURLToPath(new URL(name, contractDir)), 'utf8')
    t.is(committed, content, `contract/${name} matches a fresh export`)
  }
})
