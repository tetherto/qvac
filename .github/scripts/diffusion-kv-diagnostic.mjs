import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const TARGET =
  'ABot-World: CPU streaming, KV on matches resident frames across history updates'

export function prepareSource(source, backend) {
  assert(['gpu', 'cuda0', 'vulkan0'].includes(backend), 'Expected gpu, cuda0 or vulkan0')
  const registration = "const test = require('brittle')"
  assert.equal(source.split(registration).length - 1, 1, 'Test registration changed')
  const backendConfig = "config: { backend: 'gpu'"
  assert.equal(source.split(backendConfig).length - 1, 3, 'Scene/fit/session configuration changed')
  assert.equal(
    source.split('          return blocks').length - 1,
    1,
    'Walk capture location changed'
  )
  const selected = source
    .replace(
      registration,
      `const brittle = require('brittle')
const test = (name, ...args) => {
  if (name === ${JSON.stringify(TARGET)}) return brittle(name, ...args)
}
let diagnosticInvocation = 0`
    )
    .replaceAll(backendConfig, `config: { backend: '${backend}'`)
  return selected.replace(
    '          return blocks',
    `          const captureDir = proc.env.DIAGNOSTIC_OUTPUT_DIR
          if (captureDir) {
            fs.mkdirSync(captureDir, { recursive: true })
            const invocation = diagnosticInvocation++
            fs.writeFileSync(path.join(captureDir, 'walk-' + invocation + '.json'), JSON.stringify(config))
            for (let block = 0; block < blocks.length; block++) {
              const frames = blocks[block]
              fs.writeFileSync(path.join(captureDir, 'walk-' + invocation + '-block-' + block + '-last.png'), frames[frames.length - 1])
            }
          }
          return blocks`
  )
}

export function assessResult(log, status, backend) {
  const native =
    backend === 'gpu'
      ? log.match(/runtime=(CUDA\d+|Vulkan\d+), params=\1/)?.[1]
      : backend === 'cuda0'
        ? 'CUDA0'
        : 'Vulkan0'
  const assertions = log.match(/^# asserts = (\d+)\/(\d+) pass$/m)
  return (
    status === 0 &&
    /^# tests = 1\/1 pass$/m.test(log) &&
    assertions !== null &&
    Number(assertions[1]) === Number(assertions[2]) &&
    Number(assertions[2]) >= 45 &&
    Boolean(native) &&
    log.includes(`runtime=${native}, params=${native}`) &&
    log.includes(`runtime=${native}, params=CPU`) &&
    log.includes('stream_layers=true')
  )
}

function main() {
  const args = Object.fromEntries(
    Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [
      process.argv[2 + i * 2],
      process.argv[3 + i * 2]
    ])
  )
  for (const key of ['--workdir', '--output', '--bare']) assert(args[key], `Missing ${key}`)
  const workdir = path.resolve(args['--workdir'])
  const output = path.resolve(args['--output'])
  fs.mkdirSync(output, { recursive: true })
  const source = fs.readFileSync(path.join(workdir, 'test/integration/abot-world.test.js'), 'utf8')
  const staged = 'test/integration/abot-kv-diagnostic.test.js'
  const results = []
  for (const backend of ['gpu', 'cuda0', 'vulkan0']) {
    const prepared = prepareSource(source, backend)
    fs.writeFileSync(path.join(workdir, staged), prepared)
    fs.writeFileSync(path.join(output, `selected-test-${backend}.js`), prepared)
    for (let repeat = 1; repeat <= 2; repeat++) {
      const name = `${backend}-${repeat}`
      const started = Date.now()
      const child = spawnSync(args['--bare'], [staged, '--exit'], {
        cwd: workdir,
        env: {
          ...process.env,
          CI: 'true',
          NO_GPU: 'false',
          DIAGNOSTIC_OUTPUT_DIR: path.join(output, name)
        },
        encoding: 'utf8',
        timeout: 900_000,
        maxBuffer: 32 * 1024 * 1024
      })
      const log = (child.stdout || '') + (child.stderr || '')
      fs.writeFileSync(path.join(output, `${name}.log`), log)
      process.stdout.write(log)
      results.push({
        backend,
        observedBackend: log.match(/runtime=(CUDA\d+|Vulkan\d+), params=\1/)?.[1],
        repeat,
        status: child.status,
        signal: child.signal,
        error: child.error?.message,
        seconds: (Date.now() - started) / 1000,
        passed: assessResult(log, child.status, backend)
      })
      fs.writeFileSync(
        path.join(output, 'results.json'),
        JSON.stringify(
          {
            target: TARGET,
            originalTestSha256: createHash('sha256').update(source).digest('hex'),
            results
          },
          null,
          2
        ) + '\n'
      )
    }
  }
  const summary =
    [
      '| Backend | Repeat | Passed | Seconds |',
      '|---|---:|---|---:|',
      ...results.map(
        (r) => `| ${r.backend} | ${r.repeat} | ${r.passed} | ${r.seconds.toFixed(1)} |`
      )
    ].join('\n') + '\n'
  fs.writeFileSync(path.join(output, 'summary.md'), summary)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  if (results.some((r) => !r.passed)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
