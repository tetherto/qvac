#!/usr/bin/env node
// diffusion's test:integration, as integration-test-nx.yml ran it: main's model and perf env, then the configuration's
// --set pairs, then test:integration:generate and test:integration, both tee'd into test-output.log.
//
//   node ci/integration.mjs [--set NAME=value]...

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const PKG = fileURLToPath(new URL('..', import.meta.url))

// main's modelEnv and perf runs, which a benchmarks.yml dispatch may override, then the configuration's pairs.
export function environment(argv, base = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: { set: { type: 'string', multiple: true, default: [] } },
    strict: true
  })
  const env = {
    ...base,
    LTX_DOWNLOAD: 'false',
    LTX_LLM_FILE: 'gemma-3-12b-it-UD-Q2_K_XL.gguf',
    QVAC_PERF_RUNS: base.QVAC_PERF_RUNS || '3',
    QVAC_PERF_WARMUP_RUNS: base.QVAC_PERF_WARMUP_RUNS || '0'
  }
  for (const pair of values.set) {
    const at = pair.indexOf('=')
    if (at < 1) throw new Error(`--set takes NAME=value, got '${pair}'`)
    env[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return env
}

// One npm script, its output both on the console and appended to the log; resolves to its exit code.
export function tee(script, env, log) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      cwd: PKG,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    })
    for (const [from, to] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ]) {
      from.on('data', (chunk) => {
        to.write(chunk)
        log.write(chunk)
      })
    }
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = environment(process.argv.slice(2))
  const log = createWriteStream(join(PKG, 'test-output.log'))
  let code = await tee('test:integration:generate', env, log)
  if (code === 0) code = await tee('test:integration', env, log)
  log.end()
  process.exit(code)
}
