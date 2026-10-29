#!/usr/bin/env node
// tts's test:integration, as main's desktop test workflow ran it: the suite with the addon's prebuilds on the library path,
// main's per-test timeout and the configuration's GPU backend. The manifest supplies the models.
//
//   node ci/integration.mjs [--script test:integration:smoke] [--lib <dir>] [--set NAME=value]...

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PKG = fileURLToPath(new URL('..', import.meta.url))

// main's modelEnv (--lib appends a directory to LD_LIBRARY_PATH, as the CUDA rows did), then the --set pairs.
export function options(argv, base = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      script: { type: 'string', default: 'test:integration' },
      lib: { type: 'string', multiple: true, default: [] },
      set: { type: 'string', multiple: true, default: [] },
      config: { type: 'string' }
    },
    strict: true
  })
  const lib = join(PKG, 'prebuilds', `${process.platform}-${process.arch}`)
  const env = {
    ...base,
    INTEGRATION_TEST_TIMEOUT: '1800',
    LD_LIBRARY_PATH: [lib, ...values.lib].join(':'),
    DYLD_LIBRARY_PATH: lib
  }
  for (const pair of values.set) {
    const at = pair.indexOf('=')
    if (at < 1) throw new Error(`--set takes NAME=value, got '${pair}'`)
    env[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return { script: values.script, config: values.config, env }
}

export function run(cmd, args, env) {
  return spawnSync(cmd, args, {
    cwd: PKG,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  }).status
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = options(process.argv.slice(2))
  process.exit(run('npm', ['run', o.script], o.env) ?? 1)
}
