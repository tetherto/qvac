'use strict'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The scheduler publishes run-specs so monitor-test-run can reschedule a slot
// Device Farm errored before any test ran. The monitor keys those recipes by slot
// index, so a list that drifts out of step with run-arns would retry a slot on
// another slot's hardware. These tests pin the 1:1 alignment across every
// scheduling mode by running the action's own shell body.

const HERE = dirname(fileURLToPath(import.meta.url))
const ACTION = join(HERE, '..', 'action.yml')

// The action interpolates workflow context before bash ever sees it.
const CONTEXT = new Map([
  ['${{ github.event_name }}', 'push'],
  ['${{ github.run_number }}', '7'],
  ['${{ github.event.pull_request.number || github.run_number }}', '42'],
  ['${{ github.run_id }}', '1234'],
  ['${{ github.run_attempt }}', '1']
])

const ONE_SPEC = JSON.stringify([{ name: 'functional', grep: '', arn: 'arn:spec:1' }])
const TWO_SPECS = JSON.stringify([
  { name: 'lavasr', grep: 'runLavasr', arn: 'arn:spec:1' },
  { name: 'parler', grep: 'runParler', arn: 'arn:spec:2' }
])

function actionScript() {
  const lines = readFileSync(ACTION, 'utf8').split('\n')
  const start = lines.indexOf('      run: |')
  assert.notEqual(start, -1, 'scheduler action must contain a single run block')
  let script = collectBlock(lines.slice(start + 1)).join('\n')
  for (const [expression, value] of CONTEXT) script = script.split(expression).join(value)
  assert.equal(
    /\$\{\{/.test(script),
    false,
    'every workflow expression must be substituted before running the script'
  )
  return script
}

function collectBlock(lines) {
  const body = []
  for (const line of lines) {
    if (line.trim() !== '' && !line.startsWith('        ')) break
    body.push(line.slice(8))
  }
  return body
}

// `aws devicefarm schedule-run` is the only call these modes make; echo a unique
// ARN so run_arns grows once per call, exactly as the real CLI does.
const FAKE_AWS = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const state = process.env.FAKE_AWS_STATE
const argv = process.argv.slice(2)
if (argv[1] !== 'schedule-run') {
  process.stdout.write('')
  process.exit(0)
}
const path = join(state, 'calls')
const seen = existsSync(path) ? readFileSync(path, 'utf8').split('\\n').filter(Boolean) : []
appendFileSync(path, 'call\\n')
process.stdout.write('arn:aws:devicefarm:us-west-2:1:run:proj-1/run' + (seen.length + 1))
`

function writeFakeCli(root) {
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const aws = join(bin, 'aws')
  writeFileSync(aws, FAKE_AWS)
  chmodSync(aws, 0o755)
  return bin
}

function parseOutputs(path) {
  const outputs = {}
  if (!existsSync(path)) return outputs
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1)
  }
  return outputs
}

function schedule(env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'schedule-specs-'))
  try {
    const state = join(root, 'state')
    mkdirSync(state)
    const bin = writeFakeCli(root)
    const script = join(root, 'schedule.sh')
    writeFileSync(script, actionScript())
    const githubOutput = join(root, 'github_output')
    writeFileSync(githubOutput, '')

    execFileSync('bash', [script], {
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_AWS_STATE: state,
        PLATFORM: 'Android',
        PROJECT_ARN: 'arn:project:1',
        ANDROID_POOL_ARN: 'arn:pool:android',
        IOS_POOL_ARN: 'arn:pool:ios',
        APP_ARN: 'arn:aws:devicefarm:us-west-2:1:upload:proj/appupload',
        TEST_PACKAGE_ARN: 'arn:upload:testpkg',
        TEST_SPECS_JSON: ONE_SPEC,
        SCHEDULING_MODE: 'dual-flagship',
        MULTI_SPEC_DUAL_FLAGSHIP: 'false',
        DEVICE_MODEL: '',
        DEVICE_MODEL_OPERATOR: '',
        DEVICE_MANUFACTURER: '',
        DEVICE_MODELS: '',
        JOB_TIMEOUT_MINUTES: '120',
        GITHUB_OUTPUT: githubOutput,
        RUNNER_TEMP: root,
        ...env
      }
    })

    const outputs = parseOutputs(githubOutput)
    return { arns: JSON.parse(outputs.run_arns), specs: JSON.parse(outputs.run_specs) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function selectorKinds(specs) {
  return specs.map((spec) => (spec.poolArn ? 'pool' : 'filter'))
}

function assertWellFormed(specs, arns) {
  assert.equal(specs.length, arns.length, 'one recipe per scheduled run')
  for (const spec of specs) {
    assert.ok(spec.name, `recipe needs a run name: ${JSON.stringify(spec)}`)
    assert.ok(spec.specArn, `recipe needs a test spec ARN: ${JSON.stringify(spec)}`)
    assert.notEqual(
      Boolean(spec.poolArn),
      Boolean(spec.filter),
      `recipe needs exactly one of poolArn / filter: ${JSON.stringify(spec)}`
    )
  }
}

test('dual-flagship Android records a recipe per flagship filter', () => {
  const { arns, specs } = schedule()
  assert.equal(arns.length, 2)
  assertWellFormed(specs, arns)
  assert.deepEqual(selectorKinds(specs), ['filter', 'filter'])
})

test('dual-flagship iOS records the pool run and the iPhone filter run in order', () => {
  const { arns, specs } = schedule({ PLATFORM: 'iOS' })
  assert.equal(arns.length, 2)
  assertWellFormed(specs, arns)
  assert.deepEqual(selectorKinds(specs), ['pool', 'filter'])
})

test('sharded mode records one pool recipe per spec', () => {
  const { arns, specs } = schedule({ TEST_SPECS_JSON: TWO_SPECS })
  assert.equal(arns.length, 2)
  assertWellFormed(specs, arns)
  assert.deepEqual(selectorKinds(specs), ['pool', 'pool'])
  assert.deepEqual(specs.map((s) => s.specArn), ['arn:spec:1', 'arn:spec:2'])
})

test('multi-spec dual-flagship records a recipe for all four runs', () => {
  const { arns, specs } = schedule({ TEST_SPECS_JSON: TWO_SPECS, MULTI_SPEC_DUAL_FLAGSHIP: 'true' })
  assert.equal(arns.length, 4)
  assertWellFormed(specs, arns)
  assert.deepEqual(selectorKinds(specs), ['filter', 'filter', 'filter', 'filter'])
})

test('single-pool mode records one pool recipe', () => {
  const { arns, specs } = schedule({ SCHEDULING_MODE: 'single-pool' })
  assert.equal(arns.length, 1)
  assertWellFormed(specs, arns)
  assert.deepEqual(selectorKinds(specs), ['pool'])
})

test('single-device mode records one filter recipe', () => {
  const { arns, specs } = schedule({ SCHEDULING_MODE: 'single-device', DEVICE_MODEL: 'Pixel 9' })
  assert.equal(arns.length, 1)
  assertWellFormed(specs, arns)
  assert.deepEqual(selectorKinds(specs), ['filter'])
})

test('manual-devices keeps recipes in the spec-major order the ARNs use', () => {
  const { arns, specs } = schedule({
    SCHEDULING_MODE: 'manual-devices',
    DEVICE_MODELS: 'Pixel 9, Galaxy S25 Ultra',
    TEST_SPECS_JSON: TWO_SPECS
  })
  assert.equal(arns.length, 4)
  assertWellFormed(specs, arns)
  assert.deepEqual(specs.map((s) => s.specArn), [
    'arn:spec:1',
    'arn:spec:1',
    'arn:spec:2',
    'arn:spec:2'
  ])
  assert.ok(specs.slice(0, 2).every((s) => s.name.includes('lavasr')))
  assert.ok(specs.slice(2).every((s) => s.name.includes('parler')))
})
