/**
 * Validate the Python examples the docs embed with ```python file=<rootDir>/...
 *
 * The docs present each embedded block as something a reader can copy into an
 * empty directory and run. Checking that claim by inspecting import statements
 * only ever approximates it, so this runs the example instead: each file is
 * copied alone into a temp directory and executed there, with the examples
 * directory absent from `sys.path`.
 *
 * A sibling helper cannot resolve under those conditions — which is exactly
 * the bug this guards against. `from _common import print_progress` resolves
 * in-repo, where the script's own directory is on `sys.path`, and raises
 * ModuleNotFoundError for everyone who copies the block out.
 *
 * Installed packages are stubbed inside the child process, so the run needs no
 * SDK, no worker and no model download, and a missing third-party package
 * cannot mask a repo-local import further down the file.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const ISOLATION_RUNNER = path.join(LIB_DIR, 'run_isolated_example.py')

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

export interface IsolationResult {
  ok: boolean
  kind?: 'missing-module' | 'syntax-error' | 'exec-error'
  module?: string
  detail?: string
}

export interface PythonExampleFinding {
  mdxFile: string
  repoPath: string
  line: number
  kind: 'missing-module' | 'syntax-error' | 'exec-error'
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

/** Importable module names sitting in `dir` — what must NOT be stubbed. */
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

/** True when a Python interpreter the runner can use is on PATH. */
export function pythonAvailable(python = 'python3'): boolean {
  try {
    execFileSync(python, ['--version'], { stdio: 'pipe', timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Copy `absExample` alone into a fresh directory and execute it there.
 *
 * `neverStub` are the module names that must be allowed to fail — the example's
 * own siblings in the repo. Everything else is fabricated inside the child, so
 * the only reachable import failure is a repo-local one.
 */
export async function runExampleIsolated(
  absExample: string,
  neverStub: Set<string>,
  python = 'python3',
): Promise<IsolationResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-example-'))

  try {
    const copied = path.join(dir, path.basename(absExample))
    await fs.copyFile(absExample, copied)

    // cwd is the temp dir and the script sits beside nothing, so neither the
    // real examples directory nor the repo is reachable via sys.path.
    const raw = execFileSync(
      python,
      [ISOLATION_RUNNER, copied, JSON.stringify([...neverStub])],
      { cwd: dir, stdio: 'pipe', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    ).toString()

    return JSON.parse(raw) as IsolationResult
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string }
    const detail = e.stderr?.toString().trim() || e.message || 'unknown error'
    return { ok: false, kind: 'exec-error', detail: `isolation runner failed: ${detail}` }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Turn an isolation result into a reportable finding, or null when clean. */
export function describeFinding(
  ref: EmbeddedPythonRef,
  result: IsolationResult,
): PythonExampleFinding | null {
  if (result.ok) return null

  if (result.kind === 'missing-module') {
    return {
      ...ref,
      kind: 'missing-module',
      detail:
        `imports "${result.module}", which exists only beside it in the repo — ` +
        `a reader copying this block gets ModuleNotFoundError`,
    }
  }

  return {
    ...ref,
    kind: result.kind ?? 'exec-error',
    detail: result.detail ?? 'failed to run in isolation',
  }
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

  const siblingsByDir = new Map<string, Set<string>>()
  for (const dir of new Set(refs.map((ref) => path.dirname(ref.repoPath)))) {
    siblingsByDir.set(dir, await siblingModules(path.join(monorepoRoot, dir)))
  }

  // One example can be embedded on several pages; run each file once.
  const resultsByPath = new Map<string, IsolationResult>()
  const findings: PythonExampleFinding[] = []

  for (const ref of refs) {
    const abs = path.join(monorepoRoot, ref.repoPath)

    if (!resultsByPath.has(ref.repoPath)) {
      try {
        await fs.access(abs)
      } catch {
        // A missing target is check 1's failure to report, not this one's.
        continue
      }
      const siblings = siblingsByDir.get(path.dirname(ref.repoPath)) ?? new Set<string>()
      resultsByPath.set(ref.repoPath, await runExampleIsolated(abs, siblings, python))
    }

    const finding = describeFinding(ref, resultsByPath.get(ref.repoPath)!)
    if (finding) findings.push(finding)
  }

  return { refs, findings }
}
