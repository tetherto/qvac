import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ACTIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const COLLECT_ACTION = join(ACTIONS_DIR, 'collect-and-upload-logs/action.yml')
export const PERF_ACTION = join(ACTIONS_DIR, 'extract-addon-perf/action.yml')

const STEP_PREFIX = '    - name: '
const STEP_KEY_INDENT = '      '
const SCRIPT_INDENT = '        '
const RUN_BLOCK = `${STEP_KEY_INDENT}run: |`
const IF_KEY = `${STEP_KEY_INDENT}if: `
const EXPRESSION = /\$\{\{\s*([\w.-]+)\s*\}\}/g
const BASH_ARGS = ['--noprofile', '--norc', '-eo', 'pipefail', '-c']
const WORKSPACE_PREFIX = 'mobile-workspace-'

export const readLines = (file) => readFileSync(file, 'utf8').split('\n')

export function stepStart(lines, name) {
  const index = lines.indexOf(`${STEP_PREFIX}${name}`)
  assert.notEqual(index, -1, `step "${name}" not found`)
  return index
}

function stepLines(lines, name) {
  const rest = lines.slice(stepStart(lines, name) + 1)
  const end = rest.findIndex((line) => line.startsWith(STEP_PREFIX))
  return end === -1 ? rest : rest.slice(0, end)
}

function blockAfter(lines, start) {
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.trim() !== '' && !line.startsWith(SCRIPT_INDENT))
  return end === -1 ? rest : rest.slice(0, end)
}

function stepScript(lines, name) {
  const body = stepLines(lines, name)
  const start = body.indexOf(RUN_BLOCK)
  assert.notEqual(start, -1, `step "${name}" has no run block`)
  return blockAfter(body, start).map((line) => line.slice(SCRIPT_INDENT.length)).join('\n')
}

export function stepCondition(lines, name) {
  const line = stepLines(lines, name).find((candidate) => candidate.startsWith(IF_KEY))
  return line?.slice(IF_KEY.length)
}

function renderExpressions(script, values) {
  return script.replace(EXPRESSION, (_, key) => {
    assert.ok(key in values, `no test value for expression ${key}`)
    return values[key]
  })
}

export function makeWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), WORKSPACE_PREFIX))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  return { workspace, output: join(root, 'github-output'), summary: join(root, 'step-summary') }
}

export function writeFixture(workspace, relativePath, content = '') {
  const file = join(workspace, relativePath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

export function runStep(action, name, { workspace, output, summary, env = {}, expressions = {} }) {
  const script = renderExpressions(stepScript(readLines(action), name), expressions)
  const result = spawnSync('bash', [...BASH_ARGS, script], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
  })
  assert.equal(result.status, 0, `step "${name}" failed:\n${result.stderr}`)
  return existsSync(output) ? readFileSync(output, 'utf8') : ''
}
