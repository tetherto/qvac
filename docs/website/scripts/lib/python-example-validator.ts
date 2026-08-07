/**
 * Validate the Python examples the docs embed with ```python file=<rootDir>/...
 *
 * The docs present each embedded block as something a reader can copy into an
 * empty directory and run. That only holds if the example imports nothing but
 * installed packages: a `from _common import ...` resolves in the repo (the
 * script's own directory is on `sys.path`) and fails everywhere else, so it
 * ships green while every copied block raises ModuleNotFoundError.
 *
 * This module finds those imports by parsing the example with Python's own
 * `ast`, and reports any that resolve to a sibling file in the same examples
 * directory rather than to a package the reader installed.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const AST_HELPER = path.join(LIB_DIR, 'python_module_imports.py')

const FENCE_OPEN_RE = /^```(\w+)?(.*)$/
const FILE_ATTR_RE = /file=<rootDir>\/(\S+)/

export interface EmbeddedPythonRef {
  /** MDX file the block lives in, relative to the docs website dir. */
  mdxFile: string
  /** Referenced path, relative to the monorepo root. */
  repoPath: string
  /** 1-based line of the opening fence. */
  line: number
}

export interface PythonModuleInfo {
  imports?: string[]
  syntaxError?: string
}

export interface PythonExampleFinding {
  mdxFile: string
  repoPath: string
  line: number
  kind: 'syntax-error' | 'local-import'
  detail: string
}

/**
 * Collect every ```python block that pulls its body from a repo file.
 *
 * Only fences tagged `python` count; a `file=` on a `ts` fence is the existing
 * checker's business.
 */
export function extractEmbeddedPythonRefs(content: string, mdxFile: string): EmbeddedPythonRef[] {
  const refs: EmbeddedPythonRef[] = []
  const lines = content.split('\n')
  let inside = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith('```')) continue

    if (inside) {
      inside = false
      continue
    }

    const fence = line.match(FENCE_OPEN_RE)
    if (!fence) continue
    inside = true

    const lang = (fence[1] || '').toLowerCase()
    if (lang !== 'python' && lang !== 'py') continue

    const fileAttr = line.match(FILE_ATTR_RE)
    if (!fileAttr) continue

    refs.push({ mdxFile, repoPath: fileAttr[1]!, line: i + 1 })
  }

  return refs
}

/**
 * Which of `imports` name a module that lives beside `examplePath`.
 *
 * `siblings` is the set of importable module names in the example's directory
 * (`foo.py` -> `foo`, `bar/__init__.py` -> `bar`). A relative import is always
 * local: it carries leading dots and cannot resolve to an installed package.
 */
export function localImports(imports: string[], siblings: Set<string>): string[] {
  return imports.filter((name) => name.startsWith('.') || siblings.has(name))
}

/** Importable module names sitting in `dir`. */
export async function siblingModules(dir: string): Promise<Set<string>> {
  const names = new Set<string>()

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return names
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.py')) {
      names.add(entry.name.slice(0, -3))
    } else if (entry.isDirectory()) {
      names.add(entry.name)
    }
  }

  return names
}

/** True when a Python interpreter the helper can run is on PATH. */
export function pythonAvailable(python = 'python3'): boolean {
  try {
    execFileSync(python, ['--version'], { stdio: 'pipe', timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Parse each file with Python's `ast` and return its imported module roots.
 *
 * Throws when no interpreter is available — callers decide whether that is a
 * skip or a failure.
 */
export function parsePythonModules(
  absPaths: string[],
  python = 'python3',
): Map<string, PythonModuleInfo> {
  if (absPaths.length === 0) return new Map()

  let raw: string
  try {
    raw = execFileSync(python, [AST_HELPER, ...absPaths], {
      stdio: 'pipe',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    }).toString()
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string }
    const detail = e.stderr?.toString().trim() || e.message || 'unknown error'
    throw new Error(`failed to run ${python} ${AST_HELPER}: ${detail}`)
  }

  return new Map(Object.entries(JSON.parse(raw) as Record<string, PythonModuleInfo>))
}

/**
 * Check every embedded Python example parses and imports nothing local.
 *
 * A local import is tolerated only when the imported file is itself embedded
 * somewhere in the docs — then the reader can at least see both halves.
 */
export function validateEmbeddedPythonExamples(
  refs: EmbeddedPythonRef[],
  monorepoRoot: string,
  modules: Map<string, PythonModuleInfo>,
  siblingsByDir: Map<string, Set<string>>,
): PythonExampleFinding[] {
  const findings: PythonExampleFinding[] = []
  const embedded = new Set(refs.map((ref) => ref.repoPath))

  for (const ref of refs) {
    const abs = path.join(monorepoRoot, ref.repoPath)
    const info = modules.get(abs)
    if (!info) continue

    if (info.syntaxError) {
      findings.push({ ...ref, kind: 'syntax-error', detail: info.syntaxError })
      continue
    }

    const dir = path.dirname(ref.repoPath)
    const siblings = siblingsByDir.get(dir) ?? new Set<string>()

    for (const name of localImports(info.imports ?? [], siblings)) {
      const target = `${dir}/${name}.py`
      if (!name.startsWith('.') && embedded.has(target)) continue

      const shown = name.startsWith('.') ? `relative import "${name}"` : `"${name}" (${target})`
      findings.push({
        ...ref,
        kind: 'local-import',
        detail: `imports ${shown}, which the docs never show — a reader copying this block gets ModuleNotFoundError`,
      })
    }
  }

  return findings
}

/** Run the whole check against a docs content tree. */
export async function checkPythonExamples(
  mdxPaths: string[],
  docsDir: string,
  monorepoRoot: string,
  python = 'python3',
): Promise<{ refs: EmbeddedPythonRef[]; findings: PythonExampleFinding[] }> {
  const refs: EmbeddedPythonRef[] = []

  for (const mdxPath of mdxPaths) {
    const content = await fs.readFile(mdxPath, 'utf-8')
    refs.push(...extractEmbeddedPythonRefs(content, path.relative(docsDir, mdxPath)))
  }

  if (refs.length === 0) return { refs, findings: [] }

  const absPaths = [...new Set(refs.map((ref) => path.join(monorepoRoot, ref.repoPath)))]
  const existing: string[] = []
  for (const abs of absPaths) {
    try {
      await fs.access(abs)
      existing.push(abs)
    } catch {
      // A missing target is check 1's failure to report, not this one's.
    }
  }

  const modules = parsePythonModules(existing, python)

  const siblingsByDir = new Map<string, Set<string>>()
  for (const dir of new Set(refs.map((ref) => path.dirname(ref.repoPath)))) {
    siblingsByDir.set(dir, await siblingModules(path.join(monorepoRoot, dir)))
  }

  return { refs, findings: validateEmbeddedPythonExamples(refs, monorepoRoot, modules, siblingsByDir) }
}
