import test from 'brittle'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  buildContract,
  callShapeByHandlerType,
  contractDir,
  renderContractFiles
} from '@/scripts/contract/build-contract'
import { buildModelsRegistry } from '@/scripts/contract/build-models-registry'
import { constantsRegistry } from '@/schemas/constants-registry'
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

test('progress block is present only on the 4 progress-capable methods', (t) => {
  const { schemaDocument, manifest } = buildContract()
  const defs = schemaDocument.$defs as Record<string, unknown>

  const expected = new Set(['loadModel', 'downloadAsset', 'rag', 'finetune'])
  const actual = new Set(
    manifest.methods.filter((method) => 'progress' in method).map((method) => method.name)
  )
  t.alike(actual, expected, 'exactly loadModel/downloadAsset/rag/finetune carry a progress block')

  for (const method of manifest.methods) {
    const progress = (method as { progress?: { condition: string; responseSchema: string } })
      .progress
    if (!expected.has(method.name)) {
      t.absent(progress, `${method.name} has no progress block`)
      continue
    }
    t.ok(
      typeof progress?.condition === 'string' && progress.condition.length > 0,
      `${method.name} progress condition`
    )
    t.ok(
      progress?.condition.includes('withProgress'),
      `${method.name} condition checks withProgress`
    )

    const match = /^schema\.json#\/\$defs\/(.+)$/.exec(progress?.responseSchema ?? '')
    t.ok(match, `${method.name} progress responseSchema points into schema.json#/$defs`)
    if (match) {
      t.ok(
        defs[match[1] as string],
        `${method.name} progress responseSchema def "${match[1]}" exists`
      )
    }
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

test('schema defs carry unique titles for codegen class names', (t) => {
  // Without a `title`, JSON Schema -> codegen (e.g. datamodel-code-generator)
  // falls back to positional names like `Request1Model11` for nested unions
  // instead of `LoadModelRequest` — verified against the actual generator,
  // not assumed.
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
  // Regression guard: without per-node titling, codegen produces unlabeled
  // positional class names for every untitled nested schema (`Stats13`,
  // `Events7`, `NeuralData1`) with no indication of what they represent.
  // Every def must be fully titled down to its leaves, and all titles
  // (top-level + nested) must be globally unique in one flat check.
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

test('no generated title falls back to a bare positional number', (t) => {
  // Strict guard for the exact defect the naming algorithm exists to
  // eliminate: a nested/union schema with no discriminator or meaningful
  // property path falling back to `${prefix}${index}` (`Request1Model11`,
  // `ReloadConfigRequest2`) instead of a name derived from a discriminator
  // value, a property key, or an explicit `.meta({ title })`. A title ending
  // in digits is only legitimate when those digits are part of a real
  // technical term baked into a property name (`imageBase64` -> `...Base64`),
  // never a positional ordinal — so any trailing-digit title must end in one
  // of a short, closed list of known real terms, not just any digit run.
  const KNOWN_NUMERIC_TERMS = ['Base64']

  const { schemaDocument } = buildContract()
  const defs = schemaDocument.$defs as Record<string, JsonSchema>

  const allTitles: Array<{ title: string; defName: string }> = []
  for (const [defName, def] of Object.entries(defs)) {
    if (typeof def['title'] === 'string') allTitles.push({ title: def['title'], defName })
    const nodes: JsonSchema[] = []
    collectTitleableNodes(def, nodes)
    for (const node of nodes) {
      if (typeof node['title'] === 'string') allTitles.push({ title: node['title'], defName })
    }
  }

  t.ok(allTitles.length > 0, 'sanity: contract actually has titles to check')

  for (const { title, defName } of allTitles) {
    if (!/[0-9]$/.test(title)) continue
    const isKnownTerm = KNOWN_NUMERIC_TERMS.some((term) => title.endsWith(term))
    t.ok(
      isKnownTerm,
      `"${title}" (under ${defName}) ends in a digit but isn't a known numeric term — looks positionally suffixed`
    )
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

test('models registry catalog exports every named model constant', (t) => {
  // Regression guard for the Python (and future non-JS) client parity gap:
  // JS consumers import named constants directly from @/models/registry
  // (`QWEN3_600M_INST_Q4`, ...) and pass them straight as `modelSrc`. This
  // catalog is the language-neutral mirror of those same constants.
  const catalog = buildModelsRegistry()
  const names = Object.keys(catalog)

  t.ok(names.length > 0, 'catalog is non-empty')
  t.ok(names.includes('QWEN3_600M_INST_Q4'), 'includes a known model constant')
  t.ok(names.includes('BCI_EMBEDDER'), 'includes the hand-derived BCI_EMBEDDER constant')

  for (const name of names) {
    const entry = catalog[name] as Record<string, unknown>
    t.is(entry['name'], name, `${name}: name field matches its catalog key`)
    t.is(
      entry['src'],
      `registry://${entry['registrySource']}/${entry['registryPath']}`,
      `${name}: src is derived from registrySource/registryPath`
    )
    for (const field of ['registryPath', 'registrySource', 'modelId', 'engine', 'addon']) {
      t.ok(typeof entry[field] === 'string' && entry[field] !== '', `${name}: ${field} is set`)
    }
    t.ok(
      typeof entry['expectedSize'] === 'number' && entry['expectedSize'] > 0,
      `${name}: expectedSize is set`
    )
  }
})

test('every registered public constant is merged into schema.json as its own $def', (t) => {
  // Regression guard for the same client-parity gap as models.json, but for
  // plain constants (ModelType, PLUGIN_*, ...) that never appear in a wire
  // schema at all — see .cursor/rules/sdk/public-constants-contract.mdc.
  // Merged into the same schema.json $defs (not a separate artifact) so the
  // same datamodel-code-generator run that produces every Request/Response
  // class also produces these, with x-enum-varnames preserving each entry's
  // key names (plain JSON Schema `enum:` only carries values).
  const { schemaDocument } = buildContract()
  const defs = schemaDocument.$defs as Record<
    string,
    { title?: string; enum?: unknown[]; 'x-enum-varnames'?: string[] }
  >

  const expectedNames = new Set(Object.keys(constantsRegistry))
  t.alike(
    new Set(
      Object.keys(defs)
        .filter((name) => name.startsWith('constants.'))
        .map((name) => name.slice('constants.'.length))
    ),
    expectedNames,
    'every registered constant has a constants.* def, nothing extra'
  )

  for (const [name, schema] of Object.entries(constantsRegistry)) {
    const def = defs[`constants.${name}`]
    t.is(def?.title, name, `${name} def is titled after the registry key`)
    t.alike(
      def?.enum,
      Object.values(schema.enum),
      `${name} enum values match the registered schema`
    )
    t.alike(
      def?.['x-enum-varnames'],
      Object.keys(schema.enum),
      `${name} x-enum-varnames preserve the original key names`
    )
  }

  const modelType = defs['constants.ModelType']
  t.ok(modelType?.enum?.includes('llamacpp-completion'), 'ModelType carries its canonical values')

  const verbosity = defs['constants.Verbosity']
  t.alike(verbosity?.['x-enum-varnames'], ['ERROR', 'WARN', 'INFO', 'DEBUG'])
})

test('export is deterministic across runs', async (t) => {
  const first = await renderContractFiles()
  const second = await renderContractFiles()

  t.is(first['schema.json'], second['schema.json'])
  t.is(first['manifest.json'], second['manifest.json'])
  t.is(first['models.json'], second['models.json'])
})

test('committed artifacts are up to date', async (t) => {
  const rendered = await renderContractFiles()

  for (const [name, content] of Object.entries(rendered)) {
    const committed = await readFile(fileURLToPath(new URL(name, contractDir)), 'utf8')
    t.is(committed, content, `contract/${name} matches a fresh export`)
  }
})
