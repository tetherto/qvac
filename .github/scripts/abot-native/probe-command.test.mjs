import assert from 'node:assert/strict'
import test from 'node:test'
import { originalProbe, sanitizerCompleted } from './probe-command.mjs'

const input = {
  bare: '/tools/bare',
  testFile: '/test with spaces.js',
  output: '/results with spaces',
  environment: { PATH: '/tools' }
}
test('sanitizer executes the original Bare test and propagates memory-error failures', () => {
  const r = originalProbe({ ...input, probe: 'memcheck' })
  assert.equal(r.command, 'compute-sanitizer')
  assert.deepEqual(r.args, [
    '--tool',
    'memcheck',
    '--launch-timeout',
    '0',
    '--kill',
    '--error-exitcode',
    '86',
    input.bare,
    input.testFile,
    '--exit'
  ])
  assert.equal(input.environment.PATH, '/tools')
})

test('sanitizer requires an actual clean report, never an attachment timeout', () => {
  assert.equal(sanitizerCompleted('memcheck', '========= ERROR SUMMARY: 0 errors'), true)
  assert.equal(sanitizerCompleted('initcheck', '========= ERROR SUMMARY: 1 error'), false)
  assert.equal(sanitizerCompleted('memcheck', 'CUDA0 tests passed'), false)
  assert.equal(
    sanitizerCompleted(
      'memcheck',
      '========= Error: No attachable process found.\n========= ERROR SUMMARY: 0 errors'
    ),
    false
  )
  assert.equal(sanitizerCompleted('baseline', 'CUDA0 tests passed'), true)
})
test('graph and fusion probes change one CUDA control at a time', () => {
  const graph = originalProbe({ ...input, probe: 'no-graphs' })
  const fusion = originalProbe({ ...input, probe: 'no-fusion' })
  assert.equal(graph.env.GGML_CUDA_DISABLE_GRAPHS, '1')
  assert.equal(graph.env.GGML_CUDA_DISABLE_FUSION, undefined)
  assert.equal(fusion.env.GGML_CUDA_DISABLE_FUSION, '1')
  assert.equal(fusion.env.GGML_CUDA_DISABLE_GRAPHS, undefined)
  assert.equal(graph.command, input.bare)
})

test('native repetition provisions with the original addon without extra CUDA controls', () => {
  const repeated = originalProbe({ ...input, probe: 'repeat' })
  const baseline = originalProbe({ ...input, probe: 'baseline' })
  assert.deepEqual(repeated, baseline)
  assert.deepEqual(originalProbe({ ...input, probe: 'mmq-initcheck' }), baseline)
  assert.deepEqual(originalProbe({ ...input, probe: 'trace-repeat' }), baseline)
})
test('profiler arguments preserve paths and unsupported probes fail closed', () => {
  const r = originalProbe({ ...input, probe: 'nsys' })
  assert.equal(
    r.args[r.args.indexOf('--output') + 1],
    '/results with spaces/original-addon-trace'
  )
  assert.throws(() => originalProbe({ ...input, probe: 'unknown' }))
})
