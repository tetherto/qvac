#!/usr/bin/env node
// audiogen's test:integration, as integration-test-nx.yml ran it: the suite with the addon's prebuilds on the library
// path and the long per-test timeout. The manifest supplies every dit variant's models.
//
//   node ci/integration.mjs [--set NAME=value]...

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PKG = fileURLToPath(new URL('..', import.meta.url))

// main's modelEnv, then the configuration's --set pairs.
export function environment(argv, base = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: { set: { type: 'string', multiple: true, default: [] } },
    strict: true
  })
  const lib = join(PKG, 'prebuilds', `${process.platform}-${process.arch}`)
  const env = {
    ...base,
    INTEGRATION_TEST_TIMEOUT: '3600',
    LD_LIBRARY_PATH: lib,
    DYLD_LIBRARY_PATH: lib
  }
  for (const pair of values.set) {
    const at = pair.indexOf('=')
    if (at < 1) throw new Error(`--set takes NAME=value, got '${pair}'`)
    env[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return env
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
  process.exit(run('npm', ['run', 'test:integration'], environment(process.argv.slice(2))) ?? 1)
}
