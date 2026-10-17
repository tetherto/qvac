#!/usr/bin/env node
// Maps a set of changed files to the e2e testIds they affect, so a
// `test-e2e-smoke` run can also cover the tests a PR touched.
//
// Reads the TypeScript sources, not dist/: no build is needed, and dist is
// routinely stale relative to the working tree.
//
// Nine relations connect a changed file to testIds:
//   1. tests/*-tests.ts and tests/test-definitions.ts declare them directly.
//      Attribution is per changed line where a testId literal can be located,
//      widening to the whole file otherwise.
//   2. tests/**/executors/*.ts route by `pattern = /^prefix-/`.
//   3. anything else under tests/ reaches testIds only through the import graph,
//      resolved by finding which executors transitively import it.
//   4. a changed line inside a consumer's `resources.define('<id>', …)` reaches
//      the tests whose metadata depends on `<id>`.
//   5. an inference engine directory reaches testIds through the models it
//      serves: directory name -> `engine` in the SDK contract -> the resource
//      constants naming those models -> the tests depending on those resources.
//   6. a changed addon dependency line in the inference or SDK manifest reaches
//      them through the engines importing that addon.
//   7. a changed line in an inference schema reaches them through the names its
//      statement feeds, across schema files, and the engines importing one.
//   8. an SDK api file reaches testIds through the functions it exports and the
//      executors importing them.
//   9. a registered inference handler reaches them the same way, via the
//      operation registry.ts binds it to.
//
// 1-4 are scoped to the e2e tree; 5-9 reach into inference and the SDK. Source
// with no declared link to a test stays out of scope rather than being guessed
// at.
//
// Files that map to nothing — a consumer change outside any resource definition,
// and the fixtures/assets trees — are reported as unmapped rather than dropped.
//
// Usage:
//   --pr-files <path>          [{ filename, patch }] from the PR files API (CI)
//   --base <ref> --head <ref>  resolve the diff with git instead (local)
//   --repo-root <path>         defaults to the enclosing git work tree
//   --json <path>              write the machine-readable report
//   --github-output <path>     append `include=<ids>` for a workflow step

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TESTS_DIR = path.join(E2E_ROOT, 'tests')
// fixtures/ and assets/ hold data the tests read, so a change there can alter
// behaviour even though no relation maps it to a testId.
const SCOPED_DIRS = [TESTS_DIR, path.join(E2E_ROOT, 'fixtures'), path.join(E2E_ROOT, 'assets')]

// Hygiene, not a security control: this script is PR-authored, so the workflow
// validates what it emits before anything reaches a producer.
const SAFE_TEST_ID = /^[A-Za-z0-9._-]+$/

const PATTERN_RE =
  /^[ \t]*(?:public |protected |private |readonly )*pattern\s*=\s*(\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)/m

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"](\.[^'"]+)['"]/g

// Engine relation. No table to maintain: every link already breaks something
// else when wrong — a bad plugin directory fails to load, a stale contract
// fails `contract:check`, a bad model constant fails the download, a bad
// `dependency` throws `Unknown dependency` at run time.
const ENGINE_ROOT = 'packages/inference/src/plugins/builtin'
// The leading class rejects `.` and `..` as an engine name.
const ENGINE_DIR_RE = new RegExp(`^${ENGINE_ROOT}/([A-Za-z0-9][A-Za-z0-9._-]*)/`)
const CONTRACT_MODELS = path.resolve(E2E_ROOT, '..', 'contract', 'models.json')

const RESOURCE_DEFINE_RE = /resources\.define\(\s*['"]([^'"]+)['"]\s*,\s*\{/g
const RESOURCE_CONSTANT_RE = /(?:^|[\s,{])constant:\s*([A-Za-z0-9_]+)/m
const RESOURCE_TYPE_RE = /(?:^|[\s,{])type:\s*['"]([^'"]+)['"]/m

// Addon relation: inference's `peerDependencies`, linked to engines by the
// plugins' imports, since package and directory names differ.
const INFERENCE_SRC_DIR = path.resolve(E2E_ROOT, '..', '..', 'inference', 'src')
const INFERENCE_MANIFEST = path.resolve(INFERENCE_SRC_DIR, '..', 'package.json')
const ADDON_MANIFESTS = new Set(['packages/inference/package.json', 'packages/sdk/package.json'])
const MANIFEST_DEPENDENCY_RE = /^\s*"(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)"\s*:/
const ENGINE_DIR = path.join(INFERENCE_SRC_DIR, 'plugins', 'builtin')
// A directory without one (`asr-ggml`) is a helper the engines import.
const ENGINE_ENTRY = 'plugin.ts'
// The clause of an `import`/`export … from` stops at the next top-level statement.
const MODULE_SPECIFIER_RE =
  /\b(?:(?:import|export)\s+((?:type\s+)?(?:[^'";()=\n]|\n(?![A-Za-z_$]))*?)\s*from\s*|import\s*\(?\s*|require\(\s*)['"]([^'"]+)['"]/g
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// Schema relation. Every plugin imports the `index` barrel, so a file-level link
// names no engine; a changed line is followed through the names it feeds.
const SCHEMA_ROOT = 'packages/inference/src/schemas'
const SCHEMA_FILE_RE = new RegExp(`^${SCHEMA_ROOT}/([A-Za-z0-9][A-Za-z0-9._-]*)\\.ts$`)
const SCHEMA_DIR = path.join(INFERENCE_SRC_DIR, 'schemas')
const ALIAS_PREFIX = '@/'
// A top-level statement starts at column 0; indented lines below belong to it.
const STATEMENT_START_RE = /^[A-Za-z_$]/
const DECLARATION_RE =
  /^(export\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const\s+enum|const|let|var|function\*?|type|interface|enum|class)\s+([A-Za-z0-9_$]+)/
const IMPORT_STATEMENT_RE =
  /^import\s+(?:type\s+)?(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([A-Za-z0-9_$]+))?\s*from\s*['"]([^'"]+)['"]/
const EXPORT_LIST_RE = /^export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/
const EXPORT_STAR_RE = /^export\s+\*\s+from\s*['"]([^'"]+)['"]/
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*)/

// Handler relation. Inference dispatches a request by its operation name, and
// `registry.ts` binds each name to either a handler module or a plugin call.
// Plugin ops are left alone — the engine relation already covers them.
const INFERENCE_SRC = 'packages/inference/src'
const SDK_API_ROOT = 'packages/sdk/src/client/api'
const REGISTRY_FILE = path.resolve(E2E_ROOT, '..', '..', 'inference', 'src', 'registry.ts')
const SDK_API_DIR = path.resolve(E2E_ROOT, '..', 'src', 'client', 'api')

const REGISTRY_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*'@\/([^']+)'/g
// An entry's own fields: `op: { type: 'reply', handler: handleX }`. A trailing
// `(` means the handler is a call such as `pluginStream('translate')`.
const REGISTRY_ENTRY_RE = /([A-Za-z][A-Za-z0-9_]*):\s*\{[^{}]*?handler:\s*([A-Za-z0-9_]+)(\s*\()?/g
const SDK_EXPORT_RE = /export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/g
const SDK_WIRE_TYPE_RE = /type:\s*['"]([A-Za-z0-9_]+)['"]/g
const SDK_IMPORT_RE = /import\s*\{([\s\S]*?)\}\s*from\s*['"]@qvac\/sdk['"]/g

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split(/=(.*)/s)
    const value = () => inlineValue ?? argv[++i]
    switch (flag) {
      case '--pr-files':
        args.prFiles = value()
        break
      case '--base':
        args.base = value()
        break
      case '--head':
        args.head = value()
        break
      case '--repo-root':
        args.repoRoot = value()
        break
      case '--json':
        args.json = value()
        break
      case '--github-output':
        args.githubOutput = value()
        break
      default:
        throw new Error(`Unknown argument: ${flag}`)
    }
  }
  return args
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function listFiles(dir, predicate) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, predicate))
    else if (predicate(full)) out.push(full)
  }
  return out
}

/** Model constant -> engine id, from the SDK's generated contract. */
function readModelEngines() {
  // Absent when the checkout omitted packages/sdk/contract. Resources then
  // resolve through their literal `type` alone, which covers all but the few
  // declaring a generic one.
  if (!existsSync(CONTRACT_MODELS)) return new Map()
  try {
    const models = JSON.parse(readFileSync(CONTRACT_MODELS, 'utf8'))
    return new Map(
      Object.entries(models)
        .filter(([, model]) => typeof model?.engine === 'string' && model.engine.length > 0)
        .map(([constant, model]) => [constant, model.engine])
    )
  } catch {
    return new Map()
  }
}

/** An object literal's own fields, with every nested object dropped. */
function ownFields(body) {
  let depth = 0
  let out = ''
  for (const char of body) {
    if (char === '{') depth++
    else if (char === '}') depth--
    else if (depth === 1) out += char
  }
  return out
}

function isConsumerFile(file) {
  return path.basename(file) === 'consumer.ts'
}

function readResourceBlocks(text) {
  const blocks = []
  const newlines = []
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) newlines.push(i)
  const lineAt = (offset) => {
    let low = 0
    let high = newlines.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (newlines[mid] < offset) low = mid + 1
      else high = mid
    }
    return low + 1
  }
  for (const match of text.matchAll(RESOURCE_DEFINE_RE)) {
    // Walk braces from the `{` the pattern ended on, so a nested `config: {}`
    // does not truncate the object literal.
    let depth = 0
    let index = match.index + match[0].length - 1
    const start = index
    for (; index < text.length; index++) {
      if (text[index] === '{') depth++
      else if (text[index] === '}' && --depth === 0) break
    }
    // Unbalanced: the slice would run into the next definition and read its
    // fields as this one's. Skip rather than attribute the wrong engine.
    if (depth !== 0) continue
    blocks.push({
      id: match[1],
      startLine: lineAt(match.index),
      endLine: lineAt(index),
      // Own fields only — `config` nests its own `type`, which would otherwise
      // win whenever it is declared first.
      body: ownFields(text.slice(start, index + 1))
    })
  }
  return blocks
}

/**
 * Resource id -> engine ids, from every consumer's `resources.define`.
 *
 * Unions both links — the model constant via the contract, and the literal
 * `type` — because a resource declaring a generic `type: 'llm'` still names its
 * real engine through the constant, and vice versa when the contract is absent.
 */
function readResourceEngines(enginesByConstant) {
  const engines = new Map()
  const add = (resource, engine) => {
    if (!engine) return
    if (!engines.has(resource)) engines.set(resource, new Set())
    engines.get(resource).add(engine)
  }

  for (const file of listFiles(TESTS_DIR, isConsumerFile)) {
    for (const block of readResourceBlocks(readFileSync(file, 'utf8'))) {
      const constant = RESOURCE_CONSTANT_RE.exec(block.body)?.[1]
      add(block.id, constant && enginesByConstant.get(constant))
      add(block.id, RESOURCE_TYPE_RE.exec(block.body)?.[1])
    }
  }
  return engines
}

/**
 * The dependency keys a test preloads. Mirrors `tests/shared/collect-test-deps.ts`
 * (plural `dependencies`, `none` means preload nothing) and
 * `tests/shared/resource-lifecycle.ts` (`+` joins two resources into one key).
 */
function testDependencies(test) {
  const metadata = test.metadata ?? {}
  const declared = [
    metadata.dependency,
    ...(Array.isArray(metadata.dependencies) ? metadata.dependencies : [])
  ]
  const keys = []
  for (const entry of declared) {
    if (typeof entry !== 'string' || entry.length === 0 || entry === 'none') continue
    for (const key of entry.split('+')) if (key.length > 0) keys.push(key)
  }
  return keys
}

/** Engine id -> testIds that preload a resource served by that engine. */
function readIdsByEngine(catalog) {
  const resourceEngines = readResourceEngines(readModelEngines())
  const ids = new Map()
  for (const test of catalog) {
    for (const dependency of testDependencies(test)) {
      for (const engine of resourceEngines.get(dependency) ?? []) {
        if (!ids.has(engine)) ids.set(engine, new Set())
        ids.get(engine).add(test.testId)
      }
    }
  }
  return ids
}

function idsDependingOn(catalog, id) {
  return catalog.filter((test) => testDependencies(test).includes(id)).map((test) => test.testId)
}

function readAddonPackages() {
  if (!existsSync(INFERENCE_MANIFEST)) return null
  const peers = JSON.parse(readFileSync(INFERENCE_MANIFEST, 'utf8')).peerDependencies
  return new Set(Object.keys(peers ?? {}))
}

function resolveInferenceModule(fromFile, specifier) {
  if (specifier.startsWith(ALIAS_PREFIX)) {
    return resolveFile(path.join(INFERENCE_SRC_DIR, specifier.slice(ALIAS_PREFIX.length)))
  }
  return specifier.startsWith('.') ? resolveRelative(fromFile, specifier) : null
}

function schemaNameOf(file) {
  return file && path.dirname(file) === SCHEMA_DIR ? path.basename(file, '.ts') : null
}

function parseNameList(list) {
  return list
    .replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
    .split(',')
    .map((entry) => entry.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((entry) => {
      const [name, alias] = entry.split(/\s+as\s+/)
      return [name.trim(), (alias ?? name).trim()]
    })
    .filter(([name, alias]) => IDENTIFIER_RE.test(name) && IDENTIFIER_RE.test(alias))
}

// Imports per engine, helper files included; schema exports as `<schema>:<name>`.
function readEngineImports() {
  const engines = []
  const enginesByPackage = new Map()
  const enginesBySchemaExport = new Map()
  if (!existsSync(ENGINE_DIR)) return { engines, enginesByPackage, enginesBySchemaExport }

  const linksByFile = new Map()
  const linksOf = (file) => {
    if (linksByFile.has(file)) return linksByFile.get(file)
    const links = { packages: new Set(), schemaExports: new Set(), files: new Set() }
    linksByFile.set(file, links)
    for (const match of readFileSync(file, 'utf8').matchAll(MODULE_SPECIFIER_RE)) {
      const [, clause, specifier] = match
      if (specifier.startsWith('@') && !specifier.startsWith(ALIAS_PREFIX)) {
        const name = /^@[^/]+\/[^/]+/.exec(specifier)?.[0]
        if (name) links.packages.add(name)
        continue
      }
      const target = resolveInferenceModule(file, specifier)
      const schema = schemaNameOf(target)
      if (schema) {
        // Without a name list the import takes the whole schema.
        const names = /\{([^}]*)\}/.exec(clause ?? '')
        for (const [name] of names ? parseNameList(names[1]) : [['*']]) {
          links.schemaExports.add(`${schema}:${name}`)
        }
      } else if (target?.startsWith(`${ENGINE_DIR}${path.sep}`)) {
        links.files.add(target)
      }
    }
    return links
  }

  const add = (index, key, engine) => {
    if (!index.has(key)) index.set(key, new Set())
    index.get(key).add(engine)
  }
  for (const entry of readdirSync(ENGINE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(ENGINE_DIR, entry.name)
    if (!existsSync(path.join(dir, ENGINE_ENTRY))) continue
    engines.push(entry.name)
    const seen = new Set(listFiles(dir, (f) => f.endsWith('.ts')))
    const stack = [...seen]
    while (stack.length > 0) {
      const links = linksOf(stack.pop())
      for (const name of links.packages) add(enginesByPackage, name, entry.name)
      for (const key of links.schemaExports) add(enginesBySchemaExport, key, entry.name)
      for (const file of links.files) {
        if (seen.has(file)) continue
        seen.add(file)
        stack.push(file)
      }
    }
  }
  // Fail rather than report a parse that found nothing as coverage.
  if (engines.length === 0 || enginesByPackage.size === 0) {
    throw new Error(`No engine plugins or package imports parsed from ${ENGINE_DIR}`)
  }
  return { engines, enginesByPackage, enginesBySchemaExport }
}

function readTopLevelStatements(text) {
  const lines = text.split('\n')
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    if (!STATEMENT_START_RE.test(lines[i])) continue
    let first = i
    while (first > 0 && COMMENT_LINE_RE.test(lines[first - 1])) first--
    starts.push({ first, start: i })
  }
  return starts.map(({ first, start }, k) => {
    const last = k + 1 < starts.length ? starts[k + 1].first - 1 : lines.length - 1
    return {
      startLine: first + 1,
      endLine: last + 1,
      text: lines.slice(first, last + 1).join('\n'),
      code: lines.slice(start, last + 1).join('\n')
    }
  })
}

function readSchemaModule(file, text) {
  const statements = readTopLevelStatements(text)
  for (const statement of statements) {
    statement.locals = []
    statement.exports = []
    statement.imports = []
    statement.reexports = []
    const { code } = statement
    const declaration = DECLARATION_RE.exec(code)
    const imported = IMPORT_STATEMENT_RE.exec(code)
    const listed = EXPORT_LIST_RE.exec(code)
    const starred = EXPORT_STAR_RE.exec(code)
    if (declaration) {
      statement.locals.push(declaration[2])
      if (declaration[1]) statement.exports.push([declaration[2], declaration[2]])
    } else if (imported) {
      const [, fallback, names, namespace, specifier] = imported
      const bindings = [
        ...(fallback ? [['default', fallback]] : []),
        ...(names ? parseNameList(names) : []),
        ...(namespace ? [['*', namespace]] : [])
      ]
      const schema = schemaNameOf(resolveInferenceModule(file, specifier))
      for (const [name, local] of bindings) {
        statement.locals.push(local)
        if (schema) statement.imports.push({ schema, name, local })
      }
    } else if (listed) {
      const schema = listed[2] ? schemaNameOf(resolveInferenceModule(file, listed[2])) : null
      for (const [name, as] of parseNameList(listed[1])) {
        if (!listed[2]) statement.exports.push([name, as])
        else if (schema) statement.reexports.push({ schema, name, as })
      }
    } else if (starred) {
      const schema = schemaNameOf(resolveInferenceModule(file, starred[1]))
      if (schema) statement.reexports.push({ schema, name: '*', as: '*' })
    }
  }
  return { statements }
}

function readSchemaGraph() {
  const modules = new Map()
  const importers = new Map()
  const reexporters = new Map()
  const add = (index, key, value) => {
    if (!index.has(key)) index.set(key, [])
    index.get(key).push(value)
  }
  for (const name of existsSync(SCHEMA_DIR) ? readdirSync(SCHEMA_DIR) : []) {
    if (!name.endsWith('.ts')) continue
    const file = path.join(SCHEMA_DIR, name)
    const schema = path.basename(name, '.ts')
    const module = readSchemaModule(file, readFileSync(file, 'utf8'))
    modules.set(schema, module)
    for (const statement of module.statements) {
      for (const { schema: from, name: imported, local } of statement.imports) {
        add(importers, `${from}:${imported}`, { schema, local })
      }
      for (const { schema: from, name: exported, as } of statement.reexports) {
        add(reexporters, `${from}:${exported}`, { schema, as })
      }
    }
  }
  return { modules, importers, reexporters }
}

function mentions(text, name) {
  const isNamePart = (char) => char !== undefined && /[A-Za-z0-9_$]/.test(char)
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    if (!isNamePart(text[at - 1]) && !isNamePart(text[at + name.length])) return true
  }
  return false
}

// `override` swaps in one schema's pre-change module, for removed lines.
function reachEngines(seeds, graph, enginesBySchemaExport, override) {
  const moduleOf = (schema) =>
    override?.schema === schema ? override.module : graph.modules.get(schema)
  const engines = new Set()
  const seen = new Set()
  const queue = [...seeds]
  while (queue.length > 0) {
    const item = queue.pop()
    const key = `${item.kind}:${item.schema}:${item.name}`
    if (seen.has(key)) continue
    seen.add(key)
    const { schema, name } = item

    if (item.kind === 'local') {
      for (const statement of moduleOf(schema)?.statements ?? []) {
        for (const [local, exported] of statement.exports) {
          if (local === name) queue.push({ kind: 'export', schema, name: exported })
        }
        if (statement.imports.length > 0 || statement.locals.includes(name)) continue
        if (statement.locals.length > 0 && mentions(statement.text, name)) {
          for (const local of statement.locals) queue.push({ kind: 'local', schema, name: local })
        }
      }
      continue
    }

    for (const engine of enginesBySchemaExport.get(`${schema}:${name}`) ?? []) engines.add(engine)
    for (const engine of enginesBySchemaExport.get(`${schema}:*`) ?? []) engines.add(engine)
    for (const imported of [name, '*']) {
      for (const user of graph.importers.get(`${schema}:${imported}`) ?? []) {
        queue.push({ kind: 'local', schema: user.schema, name: user.local })
      }
    }
    for (const user of graph.reexporters.get(`${schema}:${name}`) ?? []) {
      queue.push({ kind: 'export', schema: user.schema, name: user.as })
    }
    for (const user of graph.reexporters.get(`${schema}:*`) ?? []) {
      queue.push({ kind: 'export', schema: user.schema, name })
    }
  }
  return engines
}

function schemaChangeEngines(schema, file, text, hunks, graph, enginesBySchemaExport) {
  const { added, removed } = changedLines(hunks)
  const sides = [{ module: graph.modules.get(schema), lines: added }]
  if (removed.length > 0) {
    sides.push({ module: readSchemaModule(file, textBefore(text, hunks)), lines: removed })
  }

  const engines = new Set()
  let complete = added.length + removed.length > 0
  for (const { module, lines } of sides) {
    const resolved = new Map()
    for (const { line } of lines) {
      const statement = module?.statements.find((s) => s.startLine <= line && line <= s.endLine)
      if (!statement) {
        complete = false
        continue
      }
      if (!resolved.has(statement)) {
        const seeds = [
          ...statement.locals.map((name) => ({ kind: 'local', schema, name })),
          ...statement.exports.map(([, name]) => ({ kind: 'export', schema, name })),
          ...statement.reexports
            .filter((entry) => entry.as !== '*')
            .map((entry) => ({ kind: 'export', schema, name: entry.as }))
        ]
        resolved.set(
          statement,
          reachEngines(seeds, graph, enginesBySchemaExport, { schema, module })
        )
      }
      if (resolved.get(statement).size === 0) complete = false
      for (const engine of resolved.get(statement)) engines.add(engine)
    }
  }
  return { engines, complete }
}

// `N,0` in a hunk header counts from the line after N.
function parsePatch(patch) {
  const hunks = []
  let hunk = null
  for (const text of patch.replace(/\n$/, '').split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
    if (header) {
      hunk = {
        oldStart: Number(header[1]) + (header[2] === '0' ? 1 : 0),
        newStart: Number(header[3]) + (header[4] === '0' ? 1 : 0),
        lines: []
      }
      hunks.push(hunk)
    } else if (hunk && /^[-+ ]/.test(text)) {
      hunk.lines.push({ kind: text[0], text: text.slice(1) })
    } else if (hunk && text === '') {
      // A blank context line with its leading space stripped.
      hunk.lines.push({ kind: ' ', text: '' })
    }
  }
  return hunks
}

function changedLines(hunks) {
  const added = []
  const removed = []
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const { kind, text } of hunk.lines) {
      const blank = text.trim() === ''
      if (kind === '+') {
        if (!blank) added.push({ line: newLine, text })
        newLine++
      } else if (kind === '-') {
        if (!blank) removed.push({ line: oldLine, text })
        oldLine++
      } else {
        oldLine++
        newLine++
      }
    }
  }
  return { added, removed }
}

function textBefore(text, hunks) {
  const lines = text.split('\n')
  const before = []
  let next = 1
  for (const hunk of hunks) {
    for (; next < hunk.newStart && next <= lines.length; next++) before.push(lines[next - 1])
    for (const { kind, text: line } of hunk.lines) {
      if (kind === '-') {
        before.push(line)
        continue
      }
      if (kind === ' ') before.push(line)
      next++
    }
  }
  for (; next <= lines.length; next++) before.push(lines[next - 1])
  return before.join('\n')
}

/** Operation name -> the handler module that serves it, from inference's registry. */
function readHandlerModules() {
  if (!existsSync(REGISTRY_FILE)) return new Map()
  const text = readFileSync(REGISTRY_FILE, 'utf8')

  const moduleBySymbol = new Map()
  for (const match of text.matchAll(REGISTRY_IMPORT_RE)) {
    for (const entry of match[1].split(',')) {
      const symbol = entry
        .trim()
        .split(/\s+as\s+/)
        .pop()
        .trim()
      if (symbol) moduleBySymbol.set(symbol, `${INFERENCE_SRC}/${match[2].replace(/\/index$/, '')}`)
    }
  }

  const modules = new Map()
  for (const match of text.matchAll(REGISTRY_ENTRY_RE)) {
    // `handler: pluginStream('translate')` is a plugin op, not a module.
    if (match[3]) continue
    const module = moduleBySymbol.get(match[2])
    if (module) modules.set(match[1], module)
  }
  // A reformat would silently resolve nothing, and fail-open would report that
  // as coverage. Fail instead, so the comment says the analysis was unavailable.
  if (modules.size === 0) throw new Error(`No handler bindings parsed from ${REGISTRY_FILE}`)
  return modules
}

/** SDK function name -> the testIds whose executors import it. */
function readIdsBySdkSymbol(idsByExecutor, executorDeps) {
  const ids = new Map()
  for (const [executor, deps] of executorDeps) {
    // The executor itself imports SDK functions too; `transitiveImports` only
    // returns what it reaches.
    for (const file of [executor, ...deps]) {
      for (const match of readFileSync(file, 'utf8').matchAll(SDK_IMPORT_RE)) {
        for (const entry of match[1].split(',')) {
          const symbol = entry
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]
            .trim()
          if (!symbol) continue
          if (!ids.has(symbol)) ids.set(symbol, new Set())
          for (const id of idsByExecutor.get(executor)) ids.get(symbol).add(id)
        }
      }
    }
  }
  return ids
}

/** Each api file's exported functions, and the wire types it sends. */
function readApiFiles() {
  const exportsByFile = new Map()
  const filesByWireType = new Map()
  if (!existsSync(SDK_API_DIR)) return { exportsByFile, filesByWireType }

  for (const name of readdirSync(SDK_API_DIR)) {
    if (!name.endsWith('.ts')) continue
    const text = readFileSync(path.join(SDK_API_DIR, name), 'utf8')
    exportsByFile.set(
      name,
      [...text.matchAll(SDK_EXPORT_RE)].map((match) => match[1])
    )
    for (const match of text.matchAll(SDK_WIRE_TYPE_RE)) {
      if (!filesByWireType.has(match[1])) filesByWireType.set(match[1], new Set())
      filesByWireType.get(match[1]).add(name)
    }
  }
  if ([...exportsByFile.values()].every((names) => names.length === 0)) {
    throw new Error(`No exported functions parsed from ${SDK_API_DIR}`)
  }
  return { exportsByFile, filesByWireType }
}

/**
 * Both SDK-side indexes, from one pass: an api file resolves to the tests
 * importing what it exports, and a handler module resolves the same way through
 * the operation the registry binds it to. An operation is located by the wire
 * type its api file sends; a few build the request elsewhere and only name it
 * when validating the reply, so the file named after the operation is a fallback.
 */
function readSdkRelations(idsByExecutor, executorDeps, handlerModules) {
  const { exportsByFile, filesByWireType } = readApiFiles()
  const idsBySymbol = readIdsBySdkSymbol(idsByExecutor, executorDeps)
  const testsOf = (files) => {
    const ids = new Set()
    for (const file of files) {
      for (const symbol of exportsByFile.get(file) ?? []) {
        for (const id of idsBySymbol.get(symbol) ?? []) ids.add(id)
      }
    }
    return ids
  }

  const byApiFile = new Map()
  for (const file of exportsByFile.keys()) byApiFile.set(`${SDK_API_ROOT}/${file}`, testsOf([file]))

  const byHandler = new Map()
  for (const [operation, module] of handlerModules) {
    const kebab = `${operation.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}.ts`
    const files = filesByWireType.get(operation) ?? (exportsByFile.has(kebab) ? [kebab] : [])
    const ids = byHandler.get(module) ?? new Set()
    for (const id of testsOf(files)) ids.add(id)
    byHandler.set(module, ids)
  }

  return { byApiFile, byHandler }
}

function readExecutorPattern(file) {
  const match = PATTERN_RE.exec(readFileSync(file, 'utf8'))
  if (!match) return null
  const literal = match[1]
  const lastSlash = literal.lastIndexOf('/')
  try {
    return new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1))
  } catch {
    return null
  }
}

function resolveRelative(fromFile, specifier) {
  return resolveFile(path.resolve(path.dirname(fromFile), specifier))
}

function resolveFile(base) {
  // TS ESM sources import with a .js extension that resolves to .ts on disk.
  for (const candidate of [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    base,
    path.join(base, 'index.ts')
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function transitiveImports(entry) {
  const seen = new Set()
  const stack = [entry]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const match of readFileSync(current, 'utf8').matchAll(IMPORT_RE)) {
      const dep = resolveRelative(current, match[1])
      if (!dep || seen.has(dep)) continue
      seen.add(dep)
      stack.push(dep)
    }
  }
  return seen
}

/** Unified-diff hunk headers, from either `git diff` or a PR API `patch` field. */
function parseHunkRanges(patch) {
  const ranges = []
  for (const match of patch.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    if (count > 0) ranges.push([start, start + count - 1])
  }
  return ranges
}

function idsOnChangedLines(file, fileIds, ranges) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const touched = new Set()
  let sawUnattributableChange = false

  for (const [from, to] of ranges) {
    let attributed = false
    for (let lineNo = from; lineNo <= to; lineNo++) {
      const line = lines[lineNo - 1]
      if (line === undefined) continue
      for (const id of fileIds) {
        if (line.includes(`'${id}'`) || line.includes(`"${id}"`) || line.includes(`\`${id}\``)) {
          touched.add(id)
          attributed = true
        }
      }
    }
    // A hunk that names no test (shared helper, param object, import) can affect
    // every test in the file, so widen instead of guessing.
    if (!attributed) sawUnattributableChange = true
  }

  return { touched, sawUnattributableChange }
}

/**
 * Resolves the changed files against the relations.
 *
 * `catalog` and `idsByDefinitionFile` come from the test definitions, which only
 * esbuild can load; everything else is read straight from the repository.
 */
function analyze({ repoRoot, catalog, idsByDefinitionFile, changed, patchesByFile }) {
  // Changed paths are resolved against repoRoot while the relations are scanned
  // from this script's own tree. If the two disagree nothing matches, which is
  // indistinguishable from "the PR changed no tests".
  if (!E2E_ROOT.startsWith(`${path.resolve(repoRoot)}${path.sep}`)) {
    throw new Error(`repo root ${repoRoot} does not contain ${E2E_ROOT}`)
  }

  const patches = patchesByFile ?? new Map()
  const hunksOf = (file) => (patches.has(file) ? parsePatch(patches.get(file)) : [])
  const allIds = catalog.map((test) => test.testId)
  const smokeIds = new Set(
    catalog.filter((test) => test.suites?.includes('smoke')).map((test) => test.testId)
  )

  // Paths are PR-authored and reach a privileged comment. A `.` or `..` segment
  // cannot come from the files API, so drop it before it is counted or echoed.
  const traversalFree = changed.filter(
    (file) => !file.split('/').some((segment) => segment === '.' || segment === '..')
  )
  const unmapped = []

  // A manifest is in scope only for its addon dependency lines.
  const changedManifests = traversalFree.filter((file) => ADDON_MANIFESTS.has(file))
  const addonPackages = changedManifests.length > 0 ? readAddonPackages() : null
  const changedAddons = new Set()
  const addonManifests = new Set()
  for (const file of changedManifests) {
    // Without a patch or the peer list the addon lines are unknown.
    if (!patches.has(file) || !addonPackages) {
      addonManifests.add(file)
      unmapped.push(file)
      continue
    }
    const { added, removed } = changedLines(hunksOf(file))
    for (const { text } of [...added, ...removed]) {
      const name = MANIFEST_DEPENDENCY_RE.exec(text)?.[1]
      if (!name || !addonPackages.has(name)) continue
      changedAddons.add(name)
      addonManifests.add(file)
    }
  }

  // Engine directories, addon manifests, schemas, handler modules and SDK api
  // files are in scope; the rest of inference and the SDK are not, since listing
  // files no relation can reach would be noise. A handler module is a file or a
  // directory, so both spellings match.
  const scopedPrefixes = SCOPED_DIRS.map((dir) => `${toPosix(path.relative(repoRoot, dir))}/`)
  const handlerModules = readHandlerModules()
  const handlerPaths = new Set(handlerModules.values())
  const handlerOf = (file) => {
    for (const module of handlerPaths) {
      if (file === `${module}.ts` || file.startsWith(`${module}/`)) return module
    }
    return null
  }
  const isApiFile = (file) => file.startsWith(`${SDK_API_ROOT}/`) && file.endsWith('.ts')
  const changedInScope = traversalFree.filter(
    (file) =>
      scopedPrefixes.some((p) => file.startsWith(p)) ||
      ENGINE_DIR_RE.test(file) ||
      addonManifests.has(file) ||
      SCHEMA_FILE_RE.test(file) ||
      isApiFile(file) ||
      handlerOf(file) !== null
  )

  const idsByExecutor = new Map()
  for (const file of listFiles(
    TESTS_DIR,
    (f) => f.includes(`${path.sep}executors${path.sep}`) && f.endsWith('.ts')
  )) {
    const pattern = readExecutorPattern(file)
    if (!pattern) continue
    const ids = allIds.filter((id) => pattern.test(id))
    if (ids.length > 0) idsByExecutor.set(file, ids)
  }

  const executorDeps = new Map()
  for (const file of idsByExecutor.keys()) executorDeps.set(file, transitiveImports(file))

  const affected = new Set()
  const attribution = []

  // Per engine, not per file: every file in one engine directory yields the
  // same tests, so a row each would repeat the same number.
  const changedEngines = new Set()
  for (const file of changedInScope) {
    const engine = ENGINE_DIR_RE.exec(file)?.[1]
    if (engine) changedEngines.add(engine)
  }
  let idsByEngine = null
  const idsOfEngines = (engines) => {
    idsByEngine ??= readIdsByEngine(catalog)
    const ids = new Set()
    for (const engine of engines) for (const id of idsByEngine.get(engine) ?? []) ids.add(id)
    return [...ids]
  }
  let engineImports = null
  const engineImportsOf = () => (engineImports ??= readEngineImports())
  // An untested engine next to tested ones is listed rather than hidden.
  const resolveEngines = (engines) => {
    const ids = idsOfEngines(engines)
    if (ids.length > 0) {
      for (const engine of engines) {
        if (idsOfEngines([engine]).length === 0) unmapped.push(`${ENGINE_ROOT}/${engine}`)
      }
    }
    return ids
  }
  for (const engine of changedEngines) {
    const directory = `${ENGINE_ROOT}/${engine}`
    const ids = idsOfEngines([engine])
    if (ids.length === 0) {
      // An engine no e2e resource loads. Reported rather than dropped so the
      // gap is visible the first time someone changes that plugin.
      unmapped.push(directory)
      continue
    }
    for (const id of ids) affected.add(id)
    attribution.push({ file: directory, via: 'inference engine', tests: ids.length })
  }

  const changedSchemas = changedInScope.filter((file) => SCHEMA_FILE_RE.test(file))
  // One row per package: a bump usually lands in both manifests.
  for (const name of changedAddons) {
    const ids = resolveEngines(engineImportsOf().enginesByPackage.get(name) ?? [])
    if (ids.length === 0) {
      unmapped.push(name)
      continue
    }
    for (const id of ids) affected.add(id)
    attribution.push({ file: name, via: 'addon dependency', tests: ids.length })
  }
  const schemaGraph = changedSchemas.length > 0 ? readSchemaGraph() : null
  for (const file of changedSchemas) {
    const schema = SCHEMA_FILE_RE.exec(file)[1]
    const absolute = path.join(repoRoot, file)
    const { engines, complete } = existsSync(absolute)
      ? schemaChangeEngines(
          schema,
          absolute,
          readFileSync(absolute, 'utf8'),
          hunksOf(file),
          schemaGraph,
          engineImportsOf().enginesBySchemaExport
        )
      : { engines: new Set(), complete: false }
    const ids = resolveEngines(engines)
    if (ids.length > 0) {
      for (const id of ids) affected.add(id)
      attribution.push({ file, via: 'inference schema', tests: ids.length })
    }
    // Listed as well when only some of its changes resolved.
    if (!complete || ids.length === 0) unmapped.push(file)
  }

  // Handler modules aggregate like engines — one row per module, not per file.
  // Api files are already one row each.
  const changedHandlers = new Set()
  const changedApiFiles = new Set()
  for (const file of changedInScope) {
    const module = handlerOf(file)
    if (module) changedHandlers.add(module)
    else if (isApiFile(file)) changedApiFiles.add(file)
  }
  if (changedHandlers.size > 0 || changedApiFiles.size > 0) {
    const sdk = readSdkRelations(idsByExecutor, executorDeps, handlerModules)
    const resolve = (key, index, via) => {
      const ids = [...(index.get(key) ?? [])]
      if (ids.length === 0) {
        // No e2e test reaches it, or its entry point could not be located.
        // Reported either way rather than silently empty.
        unmapped.push(key)
        return
      }
      for (const id of ids) affected.add(id)
      attribution.push({ file: key, via, tests: ids.length })
    }
    for (const module of changedHandlers) resolve(module, sdk.byHandler, 'sdk handler')
    for (const file of changedApiFiles) resolve(file, sdk.byApiFile, 'sdk api')
  }

  for (const relativeFile of changedInScope) {
    if (
      ENGINE_DIR_RE.test(relativeFile) ||
      addonManifests.has(relativeFile) ||
      SCHEMA_FILE_RE.test(relativeFile) ||
      handlerOf(relativeFile) ||
      isApiFile(relativeFile)
    ) {
      continue
    }
    const absolute = path.join(repoRoot, relativeFile)

    if (idsByDefinitionFile.has(absolute)) {
      const fileIds = idsByDefinitionFile.get(absolute)
      let ids = fileIds
      let via = 'definitions (whole file)'
      const ranges =
        existsSync(absolute) && patches.has(relativeFile)
          ? parseHunkRanges(patches.get(relativeFile))
          : []
      if (ranges.length > 0) {
        const { touched, sawUnattributableChange } = idsOnChangedLines(absolute, fileIds, ranges)
        if (touched.size > 0 && !sawUnattributableChange) {
          ids = [...touched]
          via = 'definitions (changed lines)'
        }
      }
      for (const id of ids) affected.add(id)
      attribution.push({ file: relativeFile, via, tests: ids.length })
      continue
    }

    if (idsByExecutor.has(absolute)) {
      const ids = idsByExecutor.get(absolute)
      for (const id of ids) affected.add(id)
      attribution.push({ file: relativeFile, via: 'executor pattern', tests: ids.length })
      continue
    }

    // Only lines inside a resource definition are attributed.
    if (isConsumerFile(absolute) && absolute.startsWith(`${TESTS_DIR}${path.sep}`)) {
      const hunks = existsSync(absolute) ? hunksOf(relativeFile) : []
      const { added, removed } = changedLines(hunks)
      const text = added.length + removed.length > 0 ? readFileSync(absolute, 'utf8') : ''
      const sides = [
        { blocks: added.length > 0 ? readResourceBlocks(text) : [], lines: added },
        {
          blocks: removed.length > 0 ? readResourceBlocks(textBefore(text, hunks)) : [],
          lines: removed
        }
      ]
      const resources = new Set()
      let outside = added.length + removed.length === 0
      for (const { blocks, lines } of sides) {
        for (const { line } of lines) {
          const block = blocks.find((b) => b.startLine <= line && line <= b.endLine)
          if (block) resources.add(block.id)
          else outside = true
        }
      }
      for (const id of resources) {
        const ids = idsDependingOn(catalog, id)
        // The id becomes part of a path the comment echoes.
        const key = SAFE_TEST_ID.test(id) ? `${relativeFile}#${id}` : relativeFile
        if (ids.length === 0) {
          unmapped.push(key)
          continue
        }
        for (const testId of ids) affected.add(testId)
        attribution.push({ file: key, via: 'resource definition', tests: ids.length })
      }
      if (outside) unmapped.push(relativeFile)
      continue
    }

    const viaGraph = new Set()
    for (const [executor, deps] of executorDeps) {
      if (deps.has(absolute)) for (const id of idsByExecutor.get(executor)) viaGraph.add(id)
    }
    if (viaGraph.size > 0) {
      for (const id of viaGraph) affected.add(id)
      attribution.push({ file: relativeFile, via: 'import graph', tests: viaGraph.size })
      continue
    }

    unmapped.push(relativeFile)
  }

  const affectedIds = allIds.filter((id) => affected.has(id))
  const rejectedIds = affectedIds.filter((id) => !SAFE_TEST_ID.test(id))
  const includeTests = affectedIds.filter((id) => !smokeIds.has(id) && SAFE_TEST_ID.test(id))

  const durationByTest = new Map(
    catalog.map((test) => [test.testId, Number(test.metadata?.estimatedDurationMs || 0)])
  )
  const addedMinutes =
    Math.round(
      (includeTests.reduce((total, id) => total + (durationByTest.get(id) || 0), 0) / 60000) * 10
    ) / 10

  return {
    catalog: allIds.length,
    smoke: smokeIds.size,
    changedFilesInScope: changedInScope.length,
    affected: affectedIds,
    coveredBySmoke: affectedIds.filter((id) => smokeIds.has(id)),
    includeTests,
    addedMinutes,
    rejectedIds,
    attribution,
    unmapped: [...new Set(unmapped)]
  }
}

// esbuild reaches this script through e2e's node_modules locally; a CI job that
// has not installed the e2e tree points ESBUILD_MODULE at its own copy.
async function loadEsbuild() {
  const failures = []
  for (const specifier of [process.env['ESBUILD_MODULE'], 'esbuild'].filter(Boolean)) {
    try {
      return await import(specifier)
    } catch (error) {
      failures.push(`${specifier}: ${error.message}`)
    }
  }
  throw new Error(
    `Could not load esbuild. Tried ${failures.join('; ')}. ` +
      'Install it, or set ESBUILD_MODULE to its entry point.'
  )
}

// The *-tests.ts files import only types, so esbuild can bundle them with the
// framework externalized and no dependency on a built SDK.
async function loadDefinitions(build, entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    target: 'node18',
    external: ['@qvac/test-suite', '@tetherto/test-suite-mono', '@qvac/sdk']
  })
  const encoded = Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${encoded}`)
}

function collectTestIds(module) {
  const ids = new Set()
  for (const value of Object.values(module)) {
    for (const test of Array.isArray(value) ? value : [value]) {
      if (test && typeof test === 'object' && typeof test.testId === 'string') ids.add(test.testId)
    }
  }
  return [...ids]
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repoRoot = args.repoRoot
    ? path.resolve(args.repoRoot)
    : execFileSync('git', ['-C', E2E_ROOT, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8'
      }).trim()

  const patchesByFile = new Map()
  let changed

  if (args.prFiles) {
    const entries = JSON.parse(readFileSync(args.prFiles, 'utf8'))
    changed = entries.map((entry) => entry.filename).filter(Boolean)
    for (const entry of entries) {
      // `patch` is absent for binary or very large diffs; those widen to whole-file.
      if (entry.filename && typeof entry.patch === 'string') {
        patchesByFile.set(entry.filename, entry.patch)
      }
    }
  } else if (args.base && args.head) {
    changed = execFileSync(
      'git',
      ['-C', repoRoot, 'diff', '--name-only', `${args.base}...${args.head}`],
      { encoding: 'utf8' }
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    for (const file of changed) {
      patchesByFile.set(
        file,
        execFileSync(
          'git',
          ['-C', repoRoot, 'diff', '--unified=0', `${args.base}...${args.head}`, '--', file],
          { encoding: 'utf8' }
        )
      )
    }
  } else {
    throw new Error('Provide --pr-files <path>, or --base <ref> --head <ref>')
  }

  const { build } = await loadEsbuild()

  const catalogModule = await loadDefinitions(build, path.join(TESTS_DIR, 'test-definitions.ts'))
  const catalog = catalogModule.tests || catalogModule.default
  if (!Array.isArray(catalog)) throw new Error('test-definitions.ts must export a tests array')
  const allIds = catalog.map((test) => test.testId)

  const idsByDefinitionFile = new Map()
  const claimed = new Set()
  for (const file of listFiles(TESTS_DIR, (f) => f.endsWith('-tests.ts'))) {
    const ids = collectTestIds(await loadDefinitions(build, file)).filter((id) =>
      allIds.includes(id)
    )
    if (ids.length === 0) continue
    idsByDefinitionFile.set(file, ids)
    for (const id of ids) claimed.add(id)
  }
  const inlineIds = allIds.filter((id) => !claimed.has(id))
  if (inlineIds.length > 0) {
    idsByDefinitionFile.set(path.join(TESTS_DIR, 'test-definitions.ts'), inlineIds)
  }

  const report = analyze({ repoRoot, catalog, idsByDefinitionFile, changed, patchesByFile })

  if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`)
  if (args.githubOutput) {
    // Compact JSON so it survives as a single-line step output. Handing the
    // report over this way keeps the privileged reporting job from consuming an
    // artifact produced by a job that ran PR code.
    writeFileSync(
      args.githubOutput,
      `include=${report.includeTests.join(',')}\nimpacted-json=${JSON.stringify(report)}\n`,
      { flag: 'a' }
    )
  }

  console.log(`catalog ${report.catalog} tests, smoke ${report.smoke}`)
  console.log(`changed files in scope: ${report.changedFilesInScope}`)
  console.log(
    `affected: ${report.affected.length} (${report.coveredBySmoke.length} already in smoke)`
  )
  console.log(`adding: ${report.includeTests.length} (~${report.addedMinutes} min)`)
  if (report.rejectedIds.length > 0) {
    console.log(
      `rejected ${report.rejectedIds.length} unsafe test id(s): ${report.rejectedIds.join(', ')}`
    )
  }
  for (const entry of report.attribution) {
    console.log(`  ${entry.via.padEnd(30)} ${String(entry.tests).padStart(4)}  ${entry.file}`)
  }
  for (const file of report.unmapped) console.log(`  ${'unmapped'.padEnd(30)}    -  ${file}`)
}

main().catch((error) => {
  console.error(`impacted-tests: ${error.message}`)
  process.exit(1)
})
