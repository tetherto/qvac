import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { spawnSync } from 'bare-subprocess'
import { ERR_CODES } from '@qvac/rag'

// The suite runs from the package root (the test glob is cwd-relative), so
// the compiled child script sits at a fixed path under it.
const CHILD_SCRIPT = path.resolve(os.cwd(), 'test/dist/test/fixtures/rag-rollout-child.js')

interface ChildResult {
  ok: boolean
  adapter?: string
  code?: string | number
}

function workspaceName(suffix: string) {
  return `rollout-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function makeTempDir(label: string) {
  const dir = path.join(
    os.tmpdir(),
    `qvac-rag-rollout-${label}-${os.pid()}-${Math.random().toString(16).slice(2)}`
  )
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function runConsumer(
  homeDir: string,
  config: Record<string, unknown>,
  workspace: string,
  withProvider: boolean
): ChildResult {
  const configDir = makeTempDir('config')
  const configPath = path.join(configDir, 'qvac.config.json')
  fs.writeFileSync(configPath, JSON.stringify(config))

  try {
    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') childEnv[key] = value
    }
    childEnv['HOME'] = homeDir
    childEnv['QVAC_CONFIG_PATH'] = configPath
    // HOME decides the storage root; keep other home-like variables from
    // overriding it inside the child.
    delete childEnv['SNAP_USER_COMMON']
    delete childEnv['USERPROFILE']

    const result = spawnSync(
      Bare.argv[0] ?? 'bare',
      [CHILD_SCRIPT, workspace, withProvider ? 'provider' : 'no-provider'],
      { env: childEnv }
    )
    const stdout = result.stdout ? result.stdout.toString() : ''
    for (const line of stdout.trim().split('\n').reverse()) {
      try {
        return JSON.parse(line) as ChildResult
      } catch {
        // Not the result line; keep looking.
      }
    }
    const stderr = result.stderr ? result.stderr.toString() : ''
    throw new Error(`rollout child produced no result (status ${result.status}); stderr: ${stderr}`)
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true })
  }
}

test('ragTurbovec creates new workspaces on TurboVec and pins them across restarts', (t) => {
  const home = makeTempDir('home')
  const workspace = workspaceName('turbo-create')

  try {
    const created = runConsumer(home, { ragTurbovec: true }, workspace, true)
    t.ok(created.ok, 'the flagged run opens the workspace')
    t.is(created.adapter, 'turbovec', 'the flag routes a new workspace to TurboVec')

    const reopened = runConsumer(home, {}, workspace, true)
    t.ok(reopened.ok, 'a later run without the flag opens the workspace')
    t.is(reopened.adapter, 'turbovec', 'the pinned adapter survives dropping the flag')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a workspace created before the rollout stays on HyperDB when the flag turns on', (t) => {
  const home = makeTempDir('home')
  const workspace = workspaceName('hyperdb-first')

  try {
    const created = runConsumer(home, {}, workspace, true)
    t.ok(created.ok, 'the unflagged run opens the workspace')
    t.is(created.adapter, 'hyperdb', 'without the flag a new workspace uses HyperDB')

    const reopened = runConsumer(home, { ragTurbovec: true }, workspace, true)
    t.ok(reopened.ok, 'the flagged run opens the workspace')
    t.is(reopened.adapter, 'hyperdb', 'enabling the flag later does not move a pinned workspace')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('ragTurbovec: false behaves like an unset flag', (t) => {
  const home = makeTempDir('home')
  const workspace = workspaceName('flag-false')

  try {
    const created = runConsumer(home, { ragTurbovec: false }, workspace, true)
    t.ok(created.ok, 'the run opens the workspace')
    t.is(created.adapter, 'hyperdb', 'an explicit false selects HyperDB for a new workspace')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('TurboVec creation without an index provider fails and leaves the workspace unpinned', (t) => {
  const home = makeTempDir('home')
  const workspace = workspaceName('no-provider')

  try {
    const failed = runConsumer(home, { ragTurbovec: true }, workspace, false)
    t.absent(failed.ok, 'creation fails without a provider')
    t.is(failed.code, ERR_CODES.DEPENDENCY_REQUIRED, 'the failure names the missing dependency')

    const retried = runConsumer(home, {}, workspace, true)
    t.ok(retried.ok, 'a later run recreates the workspace')
    t.is(retried.adapter, 'hyperdb', 'the failed attempt left nothing pinned')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
