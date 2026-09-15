/**
 * Test harness for the SDK e2e failed-test rerun chain.
 *
 * The logic under test is embedded in workflow / composite-action YAML, so these
 * helpers extract the real scripts and run them against fixtures — the shipped
 * code, not a copy. That is the only pre-merge net available: `on-pr-test-sdk.yml`
 * is `pull_request_target`, so it and its local actions always load from the base
 * branch and cannot be exercised on the PR that changes them.
 *
 * Node built-ins only: `policy-tests` runs `node --test` with no dependency
 * install, so no YAML library is available. The extractor is a line parser over a
 * narrow known shape — same trade-off as `parseRunnersYaml` in ./runner-names.mjs.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const scriptRequire = createRequire(import.meta.url)
const BLOCK_KEYS = new Set(['script', 'run', 'group'])

function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * Returns the block-scalar body of `key` under the line whose trimmed text is
 * `anchor` (a `- name: <step>` or a mapping key like `concurrency:`).
 *
 * Lines are dedented by the block's own indent and joined with newlines, which
 * reproduces YAML for a literal `|` block and for the one folded `>-` value read
 * here (every continuation line is extra-indented, so folding is a no-op).
 *
 * Throws when the anchor or key is missing, so a YAML restructure fails the tests
 * loudly instead of handing back an empty script that passes vacuously.
 */
export function extractBlockScalar(source, { anchor, key }) {
  if (!BLOCK_KEYS.has(key)) throw new Error(`unsupported block key: ${key}`)

  const lines = source.split('\n')
  const anchorIndex = lines.findIndex((line) => line.trim() === anchor)
  if (anchorIndex === -1) throw new Error(`anchor not found: ${anchor}`)
  const anchorIndent = indentOf(lines[anchorIndex])

  let keyIndex = -1
  for (let i = anchorIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    // Any dedent to the anchor's own column ends its block, whether that is a
    // sibling list item or the next mapping key.
    if (indentOf(line) <= anchorIndent) break
    if (line.trim() === `${key}: |` || line.trim() === `${key}: >-`) {
      keyIndex = i
      break
    }
  }
  if (keyIndex === -1) throw new Error(`key "${key}" not found under: ${anchor}`)

  const keyIndent = indentOf(lines[keyIndex])
  const body = []
  for (let i = keyIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (indentOf(line) <= keyIndent) break
    body.push(line)
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  if (body.length === 0) throw new Error(`empty block for "${key}" under: ${anchor}`)

  const blockIndent = Math.min(...body.filter((line) => line !== '').map(indentOf))
  return body.map((line) => (line === '' ? '' : line.slice(blockIndent))).join('\n')
}

export function readRepoFile(relativePath) {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

export function actionScript(actionDir, stepName) {
  return extractBlockScalar(readRepoFile(`.github/actions/${actionDir}/action.yml`), {
    anchor: `- name: ${stepName}`,
    key: 'script',
  })
}

export function workflowStepRun(workflowFile, stepName) {
  return extractBlockScalar(readRepoFile(`.github/workflows/${workflowFile}`), {
    anchor: `- name: ${stepName}`,
    key: 'run',
  })
}

export function concurrencyGroup(workflowFile) {
  return extractBlockScalar(readRepoFile(`.github/workflows/${workflowFile}`), {
    anchor: 'concurrency:',
    key: 'group',
  })
}

export function makeCore() {
  const outputs = {}
  const notices = []
  const warnings = []
  const failures = []
  return {
    outputs,
    notices,
    warnings,
    failures,
    api: {
      setOutput: (key, value) => { outputs[key] = value },
      info: () => {},
      notice: (message) => notices.push(message),
      warning: (message) => warnings.push(message),
      setFailed: (message) => failures.push(message),
      summary: { addRaw: () => {}, write: async () => {} },
    },
  }
}

export function makeContext({ runId, prNumber = 7, headSha }) {
  return {
    runId,
    serverUrl: 'https://github.com',
    repo: { owner: 'tetherto', repo: 'qvac' },
    payload: { pull_request: { number: prNumber, head: { sha: headSha } } },
  }
}

/**
 * `comments` is mutated in place, standing in for the PR's comment list.
 * `runStatuses` maps a run id to its Actions API status; a missing id 404s.
 */
export function makeGithub({ comments = [], artifacts = [], runStatuses = {} } = {}) {
  return {
    paginate: async (fn) => fn(),
    rest: {
      actions: {
        listWorkflowRunArtifacts: async () => artifacts,
        getWorkflowRun: async ({ run_id: runId }) => {
          const status = runStatuses[runId]
          if (status === undefined) {
            const error = new Error('Not Found')
            error.status = 404
            throw error
          }
          return { data: { status } }
        },
      },
      issues: {
        listComments: async () => comments,
        createComment: async ({ body }) => {
          const id = comments.length + 1
          comments.push({ id, body })
          return { data: { id } }
        },
        updateComment: async ({ comment_id: commentId, body }) => {
          const index = comments.findIndex((comment) => comment.id === commentId)
          if (index >= 0) comments[index] = { ...comments[index], body }
        },
      },
    },
  }
}

/** Runs a github-script body the way the action runtime does. */
export async function runGithubScript(script, { github, context, core, env = {} }) {
  const previous = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  try {
    const fn = new AsyncFunction('github', 'context', 'core', 'require', 'Buffer', 'process', script)
    await fn(github, context, core.api, scriptRequire, Buffer, process)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

export function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-e2e-rerun-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function readOutputs(outputPath) {
  const outputs = {}
  for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) outputs[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return outputs
}

function runStep({ command, extension, code, cwd, env }) {
  const scriptPath = join(cwd, `step.${extension}`)
  const outputPath = join(cwd, 'step-output.txt')
  writeFileSync(scriptPath, code)
  writeFileSync(outputPath, '')
  const result = spawnSync(command, [scriptPath], {
    env: { ...process.env, ...env, GITHUB_OUTPUT: outputPath },
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout, outputs: readOutputs(outputPath) }
}

/** Runs a `shell: node {0}` step body; a non-zero exit is a test failure. */
export function runNodeStep(code, { cwd, env = {} }) {
  const result = runStep({ command: process.execPath, extension: 'cjs', code, cwd, env })
  if (result.status !== 0) throw new Error(`node step exited ${result.status}:\n${result.stdout}`)
  return result
}

/** Runs a `shell: bash` step body; the caller asserts on `status`. */
export function runBashStep(code, { cwd, env = {} }) {
  return runStep({ command: 'bash', extension: 'sh', code, cwd, env })
}

/**
 * Writes results-*.json fixtures. `flatten` reproduces
 * actions/download-artifact@v8 dropping a lone matched artifact straight into
 * `path` with no per-artifact subdirectory.
 */
export function writeResults(root, artifacts, { flatten = false } = {}) {
  for (const [name, spec] of Object.entries(artifacts)) {
    const dir = flatten ? root : join(root, name)
    mkdirSync(dir, { recursive: true })
    const passedIds = spec.passedIds || []
    const failedIds = spec.failed || []
    const tests = passedIds.map((testId) => ({ testId, outcome: 'success' }))
    for (let i = passedIds.length; i < spec.passed; i++) {
      tests.push({ testId: `filler-${i}`, outcome: 'success' })
    }
    for (const testId of failedIds) tests.push({ testId, outcome: 'failure', error: 'boom' })
    writeFileSync(
      join(dir, 'results-run.json'),
      JSON.stringify({
        summary: { total: spec.total, passed: spec.passed, failed: failedIds.length },
        tests,
      }),
    )
  }
}

export function planSize(planJson) {
  return Object.values(JSON.parse(planJson))
    .flatMap((family) => Object.values(family))
    .flat()
    .length
}

/** The decoded base-state payload from the PR's hidden comment. */
export function readBaseState(comments) {
  const comment = comments.filter((c) => c.body.includes('<!-- sdk-e2e-base-state -->')).pop()
  if (!comment) return null
  const match = /<!-- sdk-e2e-base-state-data:v1:([A-Za-z0-9+/=]+) -->/.exec(comment.body)
  if (!match) throw new Error('base-state comment carries no data payload')
  return { body: comment.body, data: JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) }
}

export function readPlanComment(comments) {
  return comments.filter((c) => c.body.includes('<!-- sdk-e2e-rerun-plan -->')).pop()
}

/**
 * Evaluates a GitHub expression template. GitHub's `&&` / `||` return the operand
 * and treat '' as falsy, matching JS, so the body evaluates directly once the
 * context lookups are rewritten. Throws on a lookup this shim does not map.
 */
export function evaluateExpression(template, context) {
  return template.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => {
    const js = expression
      .replace(/format\(/g, '__format(')
      .replace(/github\.event\.pull_request\.number/g, '__ctx.prNumber')
      .replace(/github\.event\.action/g, '__ctx.action')
      .replace(/github\.event\.label\.name/g, '__ctx.label')
      .replace(/github\.workflow/g, '__ctx.workflow')
      .replace(/github\.ref/g, '__ctx.ref')
    if (/github\./.test(js)) throw new Error(`unmapped context lookup in: ${expression.trim()}`)
    const format = (spec, ...args) => spec.replace(/\{(\d+)\}/g, (__, index) => args[index])
    const value = new Function('__ctx', '__format', `return (${js});`)(context, format)
    return value === null || value === undefined || value === false ? '' : String(value)
  })
}
