/**
 * Report whether the Python examples the docs embed still run standalone.
 *
 * This is a convenience view for `test:examples`, not the enforcing check. The
 * guard lives with the files it protects, in
 * `packages/sdk-python/tests/test_examples_standalone.py`, because
 * `docs-website-pr-checks.yml` only triggers on `docs/website/**` and would
 * miss a PR that touches nothing but the examples.
 *
 * Both call the same runner, so there is one implementation of the isolation
 * logic: each example is copied alone into a temp directory and executed there,
 * with the examples directory off `sys.path`.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const MONOREPO_ROOT_FROM_LIB = path.resolve(LIB_DIR, '..', '..', '..', '..')

/** Canonical isolation runner, owned by the Python package. */
export const RUNNER_REL_PATH = 'packages/sdk-python/scripts/run_isolated_example.py'

/** Example directories the docs draw Python from, relative to the repo root. */
export const PYTHON_EXAMPLE_DIRS = ['packages/sdk-python/examples']

export const ISOLATION_KINDS = ['missing-module', 'syntax-error', 'exec-error'] as const

export type IsolationKind = (typeof ISOLATION_KINDS)[number]

export interface IsolationResult {
  ok: boolean
  kind?: IsolationKind
  module?: string
  detail?: string
}

export interface PythonExampleFinding {
  /** Path relative to the monorepo root. */
  file: string
  kind: IsolationKind
  detail: string
}

/**
 * Validate the runner's stdout instead of casting it.
 *
 * The pass/fail contract lives in two languages; an unchecked cast would let a
 * renamed kind flow through as a valid-looking result and quietly degrade the
 * failure message rather than failing.
 */
export function parseIsolationResult(raw: string): IsolationResult {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      kind: 'exec-error',
      detail: `isolation runner emitted non-JSON: ${raw.slice(0, 200)}`,
    }
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as IsolationResult).ok !== 'boolean'
  ) {
    return {
      ok: false,
      kind: 'exec-error',
      detail: `isolation runner emitted an unexpected payload: ${raw.slice(0, 200)}`,
    }
  }

  const result = payload as IsolationResult
  if (result.ok) return { ok: true }

  if (!result.kind || !ISOLATION_KINDS.includes(result.kind)) {
    return {
      ok: false,
      kind: 'exec-error',
      detail: `isolation runner reported unknown kind ${JSON.stringify(result.kind)} — python and TypeScript are out of sync`,
    }
  }

  return result
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

/** Copy `absExample` alone into a fresh directory and execute it there. */
export async function runExampleIsolated(
  absExample: string,
  monorepoRoot = MONOREPO_ROOT_FROM_LIB,
  python = 'python3',
): Promise<IsolationResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-example-'))

  try {
    const copied = path.join(dir, path.basename(absExample))
    await fs.copyFile(absExample, copied)

    // cwd is the temp dir and the script sits beside nothing, so neither the
    // real examples directory nor the repo is reachable via sys.path.
    const raw = execFileSync(python, [path.join(monorepoRoot, RUNNER_REL_PATH), copied], {
      cwd: dir,
      stdio: 'pipe',
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }).toString()

    return parseIsolationResult(raw)
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
        `imports "${result.module}", which a reader copying this file out of ` +
        `the repo would not have — ${result.detail ?? 'ModuleNotFoundError'}`,
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

    for (const name of await listExamples(absDir)) {
      const file = `${dir}/${name}`
      checked.push(file)

      const finding = describeFinding(
        file,
        await runExampleIsolated(path.join(absDir, name), monorepoRoot, python),
      )
      if (finding) findings.push(finding)
    }
  }

  return { checked, findings }
}
