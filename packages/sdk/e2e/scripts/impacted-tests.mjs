#!/usr/bin/env node
// Maps a set of changed files to the e2e testIds they affect, so a
// `test-e2e-smoke` run can also cover the tests a PR touched.
//
// Reads the TypeScript sources, not dist/: no build is needed, and dist is
// routinely stale relative to the working tree.
//
// Three relations connect a changed file to testIds:
//   1. tests/*-tests.ts and tests/test-definitions.ts declare them directly.
//      Attribution is per changed line where a testId literal can be located,
//      widening to the whole file otherwise.
//   2. tests/**/executors/*.ts route by `pattern = /^prefix-/`.
//   3. anything else reaches testIds only through the import graph, resolved by
//      finding which executors transitively import it.
//
// Files that map to nothing — notably the per-platform consumer.ts and the
// fixtures/assets trees — are reported as unmapped rather than dropped.
//
// Usage:
//   --pr-files <path>          [{ filename, patch }] from the PR files API (CI)
//   --base <ref> --head <ref>  resolve the diff with git instead (local)
//   --repo-root <path>         defaults to the enclosing git work tree
//   --json <path>              write the machine-readable report
//   --github-output <path>     append `also-tests=<ids>` for a workflow step

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

const E2E_ROOT = path.resolve(import.meta.dirname, '..')
const TESTS_DIR = path.join(E2E_ROOT, 'tests')
// fixtures/ and assets/ hold data the tests read, so a change there can alter
// behaviour even though no relation maps it to a testId.
const SCOPED_DIRS = [TESTS_DIR, path.join(E2E_ROOT, 'fixtures'), path.join(E2E_ROOT, 'assets')]

// Emitted ids reach a shell as `--also-tests=<ids>`, so anything outside this
// shape is dropped rather than trusted — testIds come from PR-authored files.
const SAFE_TEST_ID = /^[A-Za-z0-9._-]+$/

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split(/=(.*)/s)
    const value = () => inlineValue ?? argv[++i]
    switch (flag) {
      case '--pr-files': args.prFiles = value(); break
      case '--base': args.base = value(); break
      case '--head': args.head = value(); break
      case '--repo-root': args.repoRoot = value(); break
      case '--json': args.json = value(); break
      case '--github-output': args.githubOutput = value(); break
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

const PATTERN_RE =
  /^[ \t]*(?:public |protected |private |readonly )*pattern\s*=\s*(\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)/m

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

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"](\.[^'"]+)['"]/g

function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
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

// Unified-diff hunk headers, from either `git diff` or a PR API `patch` field.
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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repoRoot = args.repoRoot
    ? path.resolve(args.repoRoot)
    : execFileSync('git', ['-C', E2E_ROOT, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8'
      }).trim()

  // A repo root that does not contain this script means every changed path would
  // silently fail to match, which looks identical to "the PR changed no tests".
  if (!E2E_ROOT.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`--repo-root ${repoRoot} does not contain ${E2E_ROOT}`)
  }

  const hunksByFile = new Map()
  let changed

  if (args.prFiles) {
    const entries = JSON.parse(readFileSync(args.prFiles, 'utf8'))
    changed = entries.map((entry) => entry.filename).filter(Boolean)
    for (const entry of entries) {
      // `patch` is absent for binary or very large diffs; those widen to whole-file.
      if (entry.filename && typeof entry.patch === 'string') {
        hunksByFile.set(entry.filename, parseHunkRanges(entry.patch))
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
      hunksByFile.set(
        file,
        parseHunkRanges(
          execFileSync(
            'git',
            ['-C', repoRoot, 'diff', '--unified=0', `${args.base}...${args.head}`, '--', file],
            { encoding: 'utf8' }
          )
        )
      )
    }
  } else {
    throw new Error('Provide --pr-files <path>, or --base <ref> --head <ref>')
  }

  const scopedPrefixes = SCOPED_DIRS.map((dir) => `${toPosix(path.relative(repoRoot, dir))}/`)
  const changedInScope = changed.filter((file) => scopedPrefixes.some((p) => file.startsWith(p)))

  const { build } = await loadEsbuild()

  const catalogModule = await loadDefinitions(build, path.join(TESTS_DIR, 'test-definitions.ts'))
  const catalog = catalogModule.tests || catalogModule.default
  if (!Array.isArray(catalog)) throw new Error('test-definitions.ts must export a tests array')
  const allIds = catalog.map((test) => test.testId)
  const smokeIds = new Set(
    catalog.filter((test) => test.suites?.includes('smoke')).map((test) => test.testId)
  )

  // Relation 1: definition files -> the testIds they declare.
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

  // Relation 2: executors -> pattern -> matching testIds.
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

  // Relation 3: everything else -> the executors that transitively import it.
  const executorDeps = new Map()
  for (const file of idsByExecutor.keys()) executorDeps.set(file, transitiveImports(file))

  const affected = new Set()
  const attribution = []
  const unmapped = []

  for (const relativeFile of changedInScope) {
    const absolute = path.join(repoRoot, relativeFile)

    if (idsByDefinitionFile.has(absolute)) {
      const fileIds = idsByDefinitionFile.get(absolute)
      let ids = fileIds
      let via = 'definitions (whole file)'
      const ranges = existsSync(absolute) ? (hunksByFile.get(relativeFile) ?? []) : []
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
  const alsoTests = affectedIds.filter((id) => !smokeIds.has(id) && SAFE_TEST_ID.test(id))

  const durationByTest = new Map(
    catalog.map((test) => [test.testId, Number(test.metadata?.estimatedDurationMs || 0)])
  )
  const addedMinutes =
    Math.round(
      (alsoTests.reduce((total, id) => total + (durationByTest.get(id) || 0), 0) / 60000) * 10
    ) / 10

  const report = {
    catalog: allIds.length,
    smoke: smokeIds.size,
    changedFilesInScope: changedInScope.length,
    affected: affectedIds,
    coveredBySmoke: affectedIds.filter((id) => smokeIds.has(id)),
    alsoTests,
    addedMinutes,
    rejectedIds,
    attribution,
    unmapped
  }

  if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`)
  if (args.githubOutput) {
    writeFileSync(args.githubOutput, `also-tests=${alsoTests.join(',')}\n`, { flag: 'a' })
  }

  console.log(`catalog ${allIds.length} tests, smoke ${smokeIds.size}`)
  console.log(`changed files in scope: ${changedInScope.length}`)
  console.log(
    `affected: ${affectedIds.length} (${report.coveredBySmoke.length} already in smoke)`
  )
  console.log(`adding: ${alsoTests.length} (~${addedMinutes} min)`)
  if (rejectedIds.length > 0) {
    console.log(`rejected ${rejectedIds.length} unsafe test id(s): ${rejectedIds.join(', ')}`)
  }
  for (const entry of attribution) {
    console.log(`  ${entry.via.padEnd(30)} ${String(entry.tests).padStart(4)}  ${entry.file}`)
  }
  for (const file of unmapped) console.log(`  ${'unmapped'.padEnd(30)}    -  ${file}`)
}

main().catch((error) => {
  console.error(`impacted-tests: ${error.message}`)
  process.exit(1)
})
