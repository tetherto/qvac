/**
 * Prove every Python example runs on its own.
 *
 * The docs embed these files verbatim and present each one as something a
 * reader can copy into an empty directory and run. This checks that by doing
 * it: each example is copied alone into a temp directory and executed there,
 * so the examples directory is off `sys.path` and a sibling helper cannot
 * resolve.
 *
 * That is the bug this guards against. `from _common import print_progress`
 * resolves in-repo, where the script's own directory is on `sys.path`, and
 * raises ModuleNotFoundError for everyone who copies the block out.
 *
 * Installed packages are stubbed inside the child process, so the run needs no
 * SDK, no worker and no model download, and a missing third-party package
 * cannot mask a repo-local import further down the file.
 *
 * Every `.py` in the directory is checked, not just the ones a page embeds
 * today — the contract belongs to the directory, and a file embedded tomorrow
 * is already covered.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const ISOLATION_RUNNER = path.join(LIB_DIR, 'run_isolated_example.py')

/** Example directories the docs draw Python from, relative to the repo root. */
export const PYTHON_EXAMPLE_DIRS = ['packages/sdk-python/examples']

export interface IsolationResult {
  ok: boolean
  kind?: 'missing-module' | 'syntax-error' | 'exec-error'
  module?: string
  detail?: string
}

export interface PythonExampleFinding {
  /** Path relative to the monorepo root. */
  file: string
  kind: 'missing-module' | 'syntax-error' | 'exec-error'
  detail: string
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

/** Every `.py` file directly inside `dir`, sorted. */
export async function listExamples(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.py'))
    .map((entry) => entry.name)
    .sort()
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

/** Describe a failed run, or null when the example is clean. */
export function describeFinding(
  file: string,
  result: IsolationResult,
): PythonExampleFinding | null {
  if (result.ok) return null

  if (result.kind === 'missing-module') {
    return {
      file,
      kind: 'missing-module',
      detail:
        `imports "${result.module}", which exists only beside it in the repo — ` +
        `a reader copying this example gets ModuleNotFoundError`,
    }
  }

  return {
    file,
    kind: result.kind ?? 'exec-error',
    detail: result.detail ?? 'failed to run in isolation',
  }
}

/** Run every example in every configured directory. */
export async function checkPythonExamples(
  monorepoRoot: string,
  dirs: string[] = PYTHON_EXAMPLE_DIRS,
  python = 'python3',
): Promise<{ checked: string[]; findings: PythonExampleFinding[] }> {
  const checked: string[] = []
  const findings: PythonExampleFinding[] = []

  for (const dir of dirs) {
    const absDir = path.join(monorepoRoot, dir)
    const siblings = await siblingModules(absDir)

    for (const name of await listExamples(absDir)) {
      const file = `${dir}/${name}`
      checked.push(file)

      const finding = describeFinding(
        file,
        await runExampleIsolated(path.join(absDir, name), siblings, python),
      )
      if (finding) findings.push(finding)
    }
  }

  return { checked, findings }
}
