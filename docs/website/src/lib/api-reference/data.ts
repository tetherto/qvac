/**
 * The API data of one documentation line, read from that line's snapshot.
 *
 * A line materialized from a pinned commit (or the unreleased line, as
 * `preview`) has a snapshot under `.lines/<software>/<version>/` holding the
 * software's contract and its generated surface data as they stood at that
 * commit. Every data component and every card of a page reads the snapshot of
 * the page's own line, so an older line renders its own API, never `main`'s.
 *
 * A line still held in place under `content/docs/` has no snapshot, and no
 * API data: its pages predate the data components.
 */
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { DOCUMENTED_SOFTWARE, declaredSoftware } from '../versions'
import { contractTargetOf, type ContractTarget } from './client-map'
import { toSnakeCase } from './names'
import { SchemaReader, type JsonSchema, type Shape } from './schema'

export interface ManifestMethod {
  name: string
  callShape: string
  requestSchema: string
  responseSchema: string
}

export interface ModelEntry {
  name: string
  modelId?: string
  engine?: string
  addon?: string
  quantization?: string
  expectedSize?: number
}

export interface JsFunction {
  name: string
  signature: string
  description: string
  returns: string | null
  returnFields: { name: string; type: string; required: boolean }[]
  throws: { error: string; description: string }[]
  deprecated: string | null
}

export interface PyFunction {
  name: string
  signature: string
  summary: string
}

export interface LineApi {
  /** The line's base URL: `/sdk`, `/sdk/v0.23`, or `/sdk/preview`. */
  base: string
  schema: SchemaReader
  methods: Map<string, ManifestMethod>
  models: ModelEntry[]
  js: JsFunction[]
  python: PyFunction[]
}

export interface FunctionReference {
  name: string
  description: string
  jsSignature: string
  pythonSignature: string | null
  target: ContractTarget | null
  /** The fields of the request this function sends, without wire-only fields. */
  request: Shape | null
  /** The request's JSON Schema slice, as published beside the page. */
  requestSchema: JsonSchema | null
  responseSchema: JsonSchema | null
  returns: string | null
  returnFields: JsFunction['returnFields']
  throws: JsFunction['throws']
  deprecated: string | null
}

const cache = new Map<string, LineApi | null>()


function websiteRoot(): string {
  return process.cwd()
}

/** The software, version folder, and base URL a page URL belongs to. */
export function lineOfUrl(url: string): { slug: string; version: string; base: string } | null {
  const normalized = url.replace(/\/+$/, '')
  const owners = DOCUMENTED_SOFTWARE.filter(
    (software) => normalized === software.path || normalized.startsWith(software.path + '/'),
  ).sort((a, b) => b.path.length - a.path.length)
  const software = owners[0]
  if (!software) return null
  const segment = normalized.slice(software.path.length).split('/')[1]
  if (segment === 'preview') return { slug: software.path.slice(1), version: 'preview', base: `${software.path}/preview` }
  const explicit = software.versions.find((entry) => entry.version === segment && !entry.folder.startsWith('('))
  if (explicit) return { slug: software.path.slice(1), version: explicit.version, base: `${software.path}/${explicit.version}` }
  const current = software.versions.find((entry) => entry.folder.startsWith('('))
  return current ? { slug: software.path.slice(1), version: current.version, base: software.path } : null
}

function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf-8')) as T) : null
}

/** The API data of the line holding the page at `url`, or null when it has none. */
export function lineApiForUrl(url: string): LineApi | null {
  const line = lineOfUrl(url)
  if (!line) return null
  const key = `${line.slug}@${line.version}`
  if (cache.has(key)) return cache.get(key)!

  const declaration = declaredSoftware().find((entry) => entry.declaration.path === `/${line.slug}`)?.declaration
  const snapshot = path.join(websiteRoot(), '.lines', line.slug, line.version)
  const api = declaration && existsSync(snapshot) ? loadLineApi(snapshot, declaration.paths, line.base) : null
  cache.set(key, api)
  return api
}

/**
 * Reads the API data of a tree laid out like the repository: `root` holds the
 * software's declared `paths`, the first being its documentation root.
 */
export function loadLineApi(root: string, paths: readonly string[], base: string): LineApi | null {
  const contractPath = paths.find((entry) => entry.endsWith('/contract'))
  if (!contractPath) return null
  const contract = path.join(root, contractPath)
  const generated = path.join(root, paths[0], '_generated')
  const schema = readJson<{ $defs?: Record<string, JsonSchema> }>(path.join(contract, 'schema.json'))
  const manifest = readJson<{ methods: ManifestMethod[] }>(path.join(contract, 'manifest.json'))
  if (!schema || !manifest) return null
  const models = readJson<Record<string, ModelEntry>>(path.join(contract, 'models.json')) ?? {}
  return {
    base,
    schema: new SchemaReader(schema),
    methods: new Map(manifest.methods.map((method) => [method.name, method])),
    models: Object.values(models),
    js: readJson<{ functions: JsFunction[] }>(path.join(generated, 'js-api.json'))?.functions ?? [],
    python: readJson<{ functions: PyFunction[] }>(path.join(generated, 'python-api.json'))?.functions ?? [],
  }
}

function definitionName(ref: string): string {
  return ref.replace(/^.*#\/\$defs\//, '')
}

/** Everything a reference page or a card states about one client function. */
export function functionReference(api: LineApi, name: string): FunctionReference | null {
  const js = api.js.find((fn) => fn.name === name)
  if (!js) return null
  const target = contractTargetOf(name, new Set(api.methods.keys()))
  const method = target ? api.methods.get(target.method) : undefined

  let request: Shape | null = null
  let requestSchema: JsonSchema | null = null
  let responseSchema: JsonSchema | null = null
  if (method) {
    const definition = api.schema.definition(definitionName(method.requestSchema))
    responseSchema = api.schema.definition(definitionName(method.responseSchema))
    if (definition) {
      requestSchema = selectVariant(api.schema, definition, target!)
      request = api.schema.shapeOf(requestSchema, wireOnlyFields(api.schema, requestSchema, target!))
    }
  }

  const candidates = [toSnakeCase(name), target ? toSnakeCase(target.method) : null].filter(Boolean)
  const python = candidates.map((candidate) => api.python.find((fn) => fn.name === candidate)).find(Boolean)

  return {
    name,
    description: js.description,
    jsSignature: js.signature,
    pythonSignature: python?.signature ?? null,
    target,
    request,
    requestSchema,
    responseSchema,
    returns: js.returns,
    returnFields: js.returnFields,
    throws: js.throws,
    deprecated: js.deprecated,
  }
}

/** For a multiplexed method, the one request variant this function sends. */
function selectVariant(reader: SchemaReader, definition: JsonSchema, target: ContractTarget): JsonSchema {
  if (!target.variant) return definition
  const arms = (definition.oneOf ?? definition.anyOf ?? []).map((arm) => reader.resolve(arm))
  return arms.find((arm) => arm.properties?.[target.variant!.field]?.const === target.variant!.value) ?? definition
}

/**
 * Fields the wire carries and the client sets itself: the `type` const that
 * names the method, and the discriminator a multiplexed method's function
 * fixes.
 */
function wireOnlyFields(reader: SchemaReader, schema: JsonSchema, target: ContractTarget): Set<string> {
  const hidden = new Set<string>()
  if (target.variant) hidden.add(target.variant.field)
  const arms = [schema, ...(schema.oneOf ?? schema.anyOf ?? [])].map((arm) => reader.resolve(arm))
  for (const arm of arms) {
    if (arm.properties?.type?.const !== undefined) hidden.add('type')
  }
  return hidden
}

/** Every client function of the line, in the order TypeDoc lists them. */
export function functionNames(api: LineApi): string[] {
  return api.js.map((fn) => fn.name)
}
