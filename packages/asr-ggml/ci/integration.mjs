#!/usr/bin/env node
// asr's test:integration, as main's asr integration workflow ran it: the package installs with npm (it is outside the
// pnpm workspace) and links its local build again, then both engines' suite, the whisper GPU suite and, on the
// Vulkan host, the GPU smoke test. The manifest supplies the models.
//
//   node ci/integration.mjs [--no-gpu] [--whisper-gpu] [--cuda-lib <dir>] [--vulkan-smoke] [--set NAME=value]...

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const WIN = process.platform === 'win32'

export function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'no-gpu': { type: 'boolean', default: false },
      'whisper-gpu': { type: 'boolean', default: false },
      'cuda-lib': { type: 'string', default: '' },
      'vulkan-smoke': { type: 'boolean', default: false },
      set: { type: 'string', multiple: true, default: [] },
      matrix: { type: 'string' },
      suite: { type: 'string', default: 'rtf' }
    },
    strict: true
  })
  const set = {}
  for (const pair of values.set) {
    const at = pair.indexOf('=')
    if (at < 1) throw new Error(`--set takes NAME=value, got '${pair}'`)
    set[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return { ...values, set }
}

// The prebuilds on the library path, as main exported them outside Windows.
export function libEnv(extra = '') {
  if (WIN) return {}
  const lib = join(PKG, 'prebuilds', `${process.platform}-${process.arch}`)
  return { LD_LIBRARY_PATH: extra ? `${lib}:${extra}` : lib, DYLD_LIBRARY_PATH: lib }
}

export function run(cmd, args, env = process.env) {
  return spawnSync(cmd, args, { cwd: PKG, env, stdio: 'inherit', shell: WIN }).status
}

const must = (status) => {
  if (status !== 0) process.exit(status ?? 1)
}

// npm install restores the published platform package over the local link, so link again after it.
export function install() {
  must(run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']))
  must(run('npm', ['run', 'link:platform']))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = options(process.argv.slice(2))
  const base = { ...process.env, ...o.set }
  install()
  const noGpu = o['no-gpu'] ? 'true' : 'false'
  must(
    run('npm', ['run', 'test:integration'], {
      ...base,
      ...libEnv(o['cuda-lib']),
      NO_GPU: noGpu,
      INTEGRATION_TEST_TIMEOUT: '1800'
    })
  )
  must(
    run('npm', ['run', 'test:integration:gpu'], {
      ...base,
      ...libEnv(o['cuda-lib']),
      NO_GPU: o['whisper-gpu'] ? 'false' : noGpu,
      INTEGRATION_TEST_TIMEOUT: WIN ? '1800' : '600'
    })
  )
  if (o['vulkan-smoke'])
    must(
      run('npm', ['run', 'test:stand-alone:gpu'], {
        ...base,
        LD_LIBRARY_PATH: libEnv().LD_LIBRARY_PATH
      })
    )
}
