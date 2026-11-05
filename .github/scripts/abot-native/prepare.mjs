import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { originalProbe, sanitizerCompleted } from './probe-command.mjs'

const [workdirArg, bare, outputArg] = process.argv.slice(2)
assert(
  workdirArg && bare && outputArg,
  'Expected workdir, Bare executable and output directory'
)
const workdir = path.resolve(workdirArg)
const output = path.resolve(outputArg)
fs.mkdirSync(output, { recursive: true })
const original = fs.readFileSync(
  path.join(workdir, 'test/integration/abot-world.test.js'),
  'utf8'
)
function replaceOnce(source, old, next) {
  assert.equal(source.split(old).length - 1, 1, `Pinned test changed: ${old}`)
  return source.replace(old, next)
}
let selected = replaceOnce(
  original,
  "const test = require('brittle')",
  `const brittle = require('brittle')
const test = (name, ...args) => {
  if (/^ABot-World: (CPU streaming, KV (off|on)|disk residency, KV on) matches resident frames across history updates$/.test(name)) return brittle(name, ...args)
}`
)
assert.equal(selected.split("config: { backend: 'gpu'").length - 1, 3)
selected = selected.replaceAll("config: { backend: 'gpu'", "config: { backend: 'cuda0'")
selected = replaceOnce(
  selected,
  '  return files\n}',
  `  fs.writeFileSync(proc.env.ABOT_NATIVE_INPUTS, JSON.stringify(files))
  return files
}`
)
const testFile = path.join(workdir, 'test/integration/abot-native-preparation.test.js')
fs.writeFileSync(testFile, selected)
fs.writeFileSync(path.join(output, 'selected-addon-test.js'), selected)
const invocation = originalProbe({
  probe: process.env.PROBE || 'baseline',
  bare,
  testFile,
  output,
  environment: {
    ...process.env,
    CI: 'true',
    NO_GPU: 'false',
    ABOT_NATIVE_INPUTS: path.join(output, 'inputs.json')
  }
})
fs.writeFileSync(
  path.join(output, 'original-addon-command.json'),
  JSON.stringify(
    {
      command: invocation.command,
      args: invocation.args,
      probe: process.env.PROBE || 'baseline',
      cudaControls: {
        GGML_CUDA_DISABLE_GRAPHS: invocation.env.GGML_CUDA_DISABLE_GRAPHS,
        GGML_CUDA_DISABLE_FUSION: invocation.env.GGML_CUDA_DISABLE_FUSION
      }
    },
    null,
    2
  ) + '\n'
)
const child = spawnSync(invocation.command, invocation.args, {
  cwd: workdir,
  env: invocation.env,
  encoding: 'utf8',
  detached: true,
  killSignal: 'SIGKILL',
  timeout: 2_400_000,
  maxBuffer: 32 * 1024 * 1024
})
// The wrapper may have spawned Bare. Stop our own process group on timeout so
// an orphan GPU workload cannot contaminate later diagnostic jobs.
if (child.error?.code === 'ETIMEDOUT' && child.pid) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
const log = (child.stdout || '') + (child.stderr || '')
fs.writeFileSync(path.join(output, 'original-addon.log'), log)
process.stdout.write(log)
const passed =
  child.status === 0 &&
  sanitizerCompleted(process.env.PROBE || 'baseline', log) &&
  /^# tests = 3\/3 pass$/m.test(log) &&
  /^# asserts = 181\/181 pass$/m.test(log) &&
  log.includes('runtime=CUDA0, params=disk') &&
  log.includes('runtime=CUDA0, params=CPU') &&
  log.includes('runtime=CUDA0, params=CUDA0')
fs.writeFileSync(
  path.join(output, 'original-addon-result.json'),
  JSON.stringify(
    {
      passed,
      status: child.status,
      error: child.error?.message
    },
    null,
    2
  ) + '\n'
)
if (!passed) process.exitCode = 1
