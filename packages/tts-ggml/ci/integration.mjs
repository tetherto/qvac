#!/usr/bin/env node
// tts's test:integration, as integration-test-nx.yml ran it: the suite with the addon's prebuilds on the library path,
// main's per-test timeout and the configuration's GPU backend. The manifest supplies the models.
//
//   node ci/integration.mjs [--script test:integration:smoke] [--lib <dir>] [--set NAME=value]...

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PKG = fileURLToPath(new URL('..', import.meta.url))

// The darwin WER check loads the npm asr-ggml devDependency, whose platform packages pnpm-workspace.yaml drops; main's
// per-package npm install kept them. Stage this host's one beside it, where its #host-addon import resolves.
export function stageAsrHostPackage() {
  if (process.platform !== 'darwin') return 0
  const asr = realpathSync(join(PKG, 'node_modules/@qvac/asr-ggml'))
  const { version, optionalDependencies = {} } = JSON.parse(
    readFileSync(join(asr, 'package.json'), 'utf8')
  )
  const name = `@qvac/asr-ggml-${process.platform}-${process.arch}`
  const dest = join(dirname(asr), name.slice('@qvac/'.length))
  if (!(name in optionalDependencies) || existsSync(dest)) return 0
  const tmp = mkdtempSync(join(tmpdir(), 'asr-host-'))
  if (run('npm', ['pack', `${name}@${version}`, '--pack-destination', tmp], process.env) !== 0)
    return 1
  const tgz = join(
    tmp,
    readdirSync(tmp).find((f) => f.endsWith('.tgz'))
  )
  mkdirSync(dest)
  return run('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1'], process.env)
}

// main's modelEnv (--lib appends a directory to LD_LIBRARY_PATH, as the CUDA rows did), then the --set pairs.
export function options(argv, base = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      script: { type: 'string', default: 'test:integration' },
      lib: { type: 'string', multiple: true, default: [] },
      set: { type: 'string', multiple: true, default: [] },
      matrix: { type: 'string' }
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
  return { script: values.script, matrix: values.matrix, env }
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
  if (stageAsrHostPackage() !== 0) process.exit(1)
  process.exit(run('npm', ['run', o.script], o.env) ?? 1)
}
