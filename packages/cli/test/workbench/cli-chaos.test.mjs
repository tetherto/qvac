import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { random } from './helpers/chaos.mjs'
import { parseArgs } from '../../dist/cli/index.js'
import { FLAGS } from '../../dist/cli/flags.js'

const CLI = new URL('../../dist/index.js', import.meta.url).pathname
// CLI_CHAOS_RUNS for a longer run; CLI_CHAOS_SEED replays one argument list
const RUNS = Number(process.env.CLI_CHAOS_RUNS || 40)

// what boots Core or waits for ever stays out: this run is about parsing and the paths before Core
const BOOTS = new Set([
  'print',
  'continue',
  'resume',
  'new',
  'follow',
  'join',
  'device-join',
  'chat'
])
const COMMANDS = [
  'help',
  'config',
  'logs',
  'help serve',
  'help models',
  'help nope',
  '',
  '--',
  'nope'
]
const JUNK = [
  '',
  ' ',
  '-',
  '--',
  '---x',
  '=',
  '--=x',
  '漢字',
  '-zz',
  'qvac://workspace/nope',
  '\u0000'
]
const VALUES = [
  '',
  'x',
  '0',
  '-1',
  '99999999999999999999',
  '/nonexistent',
  'nope.mjs',
  '--json',
  '漢字'
]
const EXITS = new Set([0, 1, 2, 130])
// a list the launcher refuses, or one it runs itself; the rest would boot Core and wait
function offline(args, env) {
  try {
    const { where, command } = parseArgs(args, { env })
    return where === 'launcher' && command !== 'sdk'
  } catch {
    return true
  }
}

function argv(r) {
  const words = r.pick(COMMANDS).split(' ').filter(Boolean)
  for (let i = r.int(5); i > 0; i--) {
    const flag = r.pick(FLAGS)
    if (BOOTS.has(flag.name)) {
      continue
    }

    const name = r.chance(0.2) && flag.short ? `-${flag.short}` : `--${flag.name}`
    words.push(...(flag.value && r.chance(0.8) ? [name, r.pick(VALUES)] : [name]))
  }

  if (r.chance(0.3)) {
    words.splice(r.int(words.length + 1), 0, r.pick(JUNK))
  }

  return words.filter((w) => !w.includes('\u0000'))
}

// an env var set to undefined reaches the child as the text "undefined", so unset ones stay out
function env(r, dir) {
  const vars = { ...process.env, QVAC_DATA_DIR: r.chance(0.5) ? dir : r.pick(VALUES) }
  if (r.chance(0.3)) {
    vars.QVAC_JSON = r.pick(['1', '0', 'yes', 'x'])
  }

  if (r.chance(0.2)) {
    vars.QVAC_NON_INTERACTIVE = r.pick(['1', 'nope'])
  }

  return vars
}

test('random arguments and env never crash the launcher, hang, or print a stack', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-cli-chaos-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const seeds = process.env.CLI_CHAOS_SEED
    ? [Number(process.env.CLI_CHAOS_SEED)]
    : Array.from({ length: RUNS }, (_, i) => i + 1)
  for (const seed of seeds) {
    const r = random(seed)
    const args = argv(r)
    const vars = env(r, dir)
    if (!offline(args, vars)) {
      continue
    }

    const run = spawnSync('node', [CLI, ...args], {
      encoding: 'utf8',
      timeout: 20000,
      env: vars,
      input: ''
    })
    const what = `seed ${seed}: qvac ${JSON.stringify(args)}`
    assert.equal(run.error, undefined, `${what} did not finish: ${run.error?.message}`)
    assert.ok(EXITS.has(run.status), `${what} exited ${run.status}\n${run.stderr}`)
    assert.doesNotMatch(
      run.stderr,
      /\n\s+at .*\.m?js:\d+/,
      `${what} printed a stack\n${run.stderr}`
    )
  }
})
