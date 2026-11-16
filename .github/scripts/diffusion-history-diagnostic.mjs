import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { originalProbe } from './abot-native/probe-command.mjs'

export const PARITY =
  /^ABot-World: (CPU streaming, KV (off|on)|disk residency, KV on) matches resident frames across history updates$/
export const PREDECESSORS = [
  'ABot-World: model set loads; batch generation is guarded',
  'ABot-World: interactive walk session steps through the fixed scene'
]

export function prepareHistorySource(source, history) {
  function replaceOnce(before, after) {
    assert.equal(source.split(before).length - 1, 1, `Pinned source changed: ${before}`)
    source = source.replace(before, after)
  }
  replaceOnce(
    "const test = require('brittle')",
    `const brittle = require('brittle')
const diagnosticPredecessors = ${JSON.stringify(history ? PREDECESSORS : [])}
const test = (name, ...args) => {
  if (${PARITY}.test(name) || diagnosticPredecessors.includes(name)) return brittle(name, ...args)
}
let diagnosticInvocation = 0`
  )
  // Keep the original GPU policy, configuration, shared baselines and assertions.
  replaceOnce(
    '  return files\n}',
    `  const capture = proc.env.DIAGNOSTIC_OUTPUT_DIR
  fs.writeFileSync(path.join(capture, 'inputs.json'), JSON.stringify(files))
  fs.writeFileSync(path.join(capture, 'scene.safetensors'), fs.readFileSync(files.scene))
  return files
}`
  )
  replaceOnce(
    '          return blocks',
    `          const capture = path.join(proc.env.DIAGNOSTIC_OUTPUT_DIR, 'walk-' + diagnosticInvocation++)
          fs.mkdirSync(capture, { recursive: true })
          fs.writeFileSync(path.join(capture, 'config.json'), JSON.stringify(config))
          for (let block = 0; block < blocks.length; block++) {
            for (let frame = 0; frame < blocks[block].length; frame++) {
              fs.writeFileSync(path.join(capture, 'block-' + block + '-frame-' + frame + '.png'), blocks[block][frame])
            }
          }
          return blocks`
  )
  return source
}

export function assessHistoryResult(log, status, history) {
  const tests = log.match(/^# tests = (\d+)\/(\d+) pass$/m)
  const assertions = log.match(/^# asserts = (\d+)\/(\d+) pass$/m)
  const errors = [...log.matchAll(/mean pixel error ([\d.]+) <= 1\/255/g)].map((m) =>
    Number(m[1])
  )
  const cuda = ['CUDA0', 'CPU', 'disk'].every((params) =>
    log.includes(`runtime=CUDA0, params=${params}`)
  )
  const complete =
    Number(tests?.[2]) === (history ? 5 : 3) &&
    errors.length === 135 &&
    cuda &&
    Number(assertions?.[2]) >= 181
  return {
    complete,
    passed:
      complete && status === 0 && tests[1] === tests[2] && assertions[1] === assertions[2],
    tests: tests?.[0],
    assertions: assertions?.[0],
    cuda,
    comparisons: errors.length,
    maxPixelError: errors.length ? Math.max(...errors) : null,
    failedTests: [...log.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1])
  }
}

function sha256(file) {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  try {
    let bytes
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function main() {
  const [workdirArg, bareArg, outputArg] = process.argv.slice(2)
  assert(
    workdirArg && bareArg && outputArg,
    'Expected workdir, Bare executable and output directory'
  )
  const workdir = path.resolve(workdirArg)
  const bare = path.resolve(bareArg)
  const output = path.resolve(outputArg)
  fs.mkdirSync(output, { recursive: true })
  const original = fs.readFileSync(
    path.join(workdir, 'test/integration/abot-world.test.js'),
    'utf8'
  )
  const staged = path.join(workdir, 'test/integration/abot-history-diagnostic.test.js')
  assert(!fs.existsSync(staged), 'Refuse to overwrite an existing diagnostic test')
  const metadata = {
    originalTestSha256: createHash('sha256').update(original).digest('hex'),
    limitation:
      'Five-test prefix preserves preceding ABot execution, but does not import every full-suite module. Frame writes add instrumentation. Full suite remains the reference.',
    results: []
  }
  const cases = [
    ['parity-before', false, 'baseline'],
    ['history-1', true, 'baseline'],
    ['parity-between', false, 'baseline'],
    ['history-2', true, 'baseline'],
    ['history-no-graphs', true, 'no-graphs'],
    ['history-no-fusion', true, 'no-fusion']
  ]
  const modelHashes = new Map()
  try {
    for (const [name, history, probe] of cases) {
      const capture = path.join(output, name)
      fs.mkdirSync(capture)
      const source = prepareHistorySource(original, history)
      fs.writeFileSync(staged, source)
      fs.writeFileSync(path.join(capture, 'selected-test.js'), source)
      const environment = {
        ...process.env,
        CI: 'true',
        NO_GPU: 'false',
        DIAGNOSTIC_OUTPUT_DIR: capture
      }
      // Each control starts from the same explicit graph/fusion configuration.
      delete environment.GGML_CUDA_DISABLE_GRAPHS
      delete environment.GGML_CUDA_DISABLE_FUSION
      const invocation = originalProbe({
        probe,
        bare,
        testFile: staged,
        output: capture,
        environment
      })
      fs.writeFileSync(
        path.join(capture, 'command.json'),
        JSON.stringify(
          {
            command: invocation.command,
            args: invocation.args,
            probe,
            history,
            controls: {
              GGML_CUDA_DISABLE_GRAPHS: invocation.env.GGML_CUDA_DISABLE_GRAPHS,
              GGML_CUDA_DISABLE_FUSION: invocation.env.GGML_CUDA_DISABLE_FUSION
            }
          },
          null,
          2
        )
      )
      console.log(`[history diagnostic] starting ${name}`)
      const started = Date.now()
      const fd = fs.openSync(path.join(capture, 'test-output.log'), 'w')
      let child
      try {
        child = spawnSync(invocation.command, invocation.args, {
          cwd: workdir,
          env: invocation.env,
          stdio: ['ignore', fd, fd],
          timeout: 3_600_000,
          killSignal: 'SIGKILL'
        })
      } finally {
        fs.closeSync(fd)
      }
      const log = fs.readFileSync(path.join(capture, 'test-output.log'), 'utf8')
      const result = {
        name,
        history,
        probe,
        status: child.status,
        signal: child.signal,
        error: child.error?.message,
        seconds: (Date.now() - started) / 1000,
        ...assessHistoryResult(log, child.status, history)
      }
      const inputsFile = path.join(capture, 'inputs.json')
      if (fs.existsSync(inputsFile)) {
        const inputs = JSON.parse(fs.readFileSync(inputsFile))
        result.inputs = Object.fromEntries(
          Object.entries(inputs).map(([key, file]) => {
            const actual = key === 'scene' ? path.join(capture, 'scene.safetensors') : file
            if (!modelHashes.has(actual)) modelHashes.set(actual, sha256(actual))
            return [key, { file, sha256: modelHashes.get(actual) }]
          })
        )
      }
      metadata.results.push(result)
      fs.writeFileSync(
        path.join(output, 'results.json'),
        JSON.stringify(metadata, null, 2) + '\n'
      )
      console.log(JSON.stringify(result))
    }
  } finally {
    if (fs.existsSync(staged)) fs.unlinkSync(staged)
  }
  if (metadata.results.some((r) => !r.passed)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
