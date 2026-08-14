'use strict'

const test = require('brittle')
const { parseDeviceEnv, applyDeviceEnv } = require('../utils/device-env')

// What the mobile workflow actually pushes: entries joined with a literal
// backslash-n rather than a real newline.
const PUSHED_CONFIG =
  'QVAC_PERF_RUNS=\\nQVAC_PERF_WARMUP_RUNS=\\n' +
  'QVAC_AUDIOGEN_GGML_BENCHMARK_DIT_VARIANT=sft\\n' +
  'QVAC_AUDIOGEN_GGML_BENCHMARK_USE_GPU=1\\n' +
  'QVAC_AUDIOGEN_GGML_BENCHMARK_LABEL=android-sft-gpu'

test('parseDeviceEnv reads the literal backslash-n encoding the workflow pushes', (t) => {
  const entries = parseDeviceEnv(PUSHED_CONFIG)

  t.is(entries.length, 3, 'the two empty QVAC_PERF_* entries are dropped')
  t.alike(entries[0], { key: 'QVAC_AUDIOGEN_GGML_BENCHMARK_DIT_VARIANT', value: 'sft' })
  t.alike(entries[1], { key: 'QVAC_AUDIOGEN_GGML_BENCHMARK_USE_GPU', value: '1' })
  t.alike(entries[2], { key: 'QVAC_AUDIOGEN_GGML_BENCHMARK_LABEL', value: 'android-sft-gpu' })
})

test('parseDeviceEnv also accepts real newlines', (t) => {
  const entries = parseDeviceEnv('A=1\nB=2\r\nC=3')

  t.is(entries.length, 3)
  t.is(entries[2].value, '3')
})

test('parseDeviceEnv skips blanks, comments and malformed lines', (t) => {
  const entries = parseDeviceEnv('\n# a comment\nNOEQUALS\n=novalue\nKEY=\n  B = 2  ')

  t.is(entries.length, 1, 'only the well-formed entry survives')
  t.alike(entries[0], { key: 'B', value: '2' }, 'keys and values are trimmed')
})

test('parseDeviceEnv keeps an = inside the value', (t) => {
  t.alike(parseDeviceEnv('K=a=b'), [{ key: 'K', value: 'a=b' }])
})

test('parseDeviceEnv treats empty input as no overrides', (t) => {
  t.alike(parseDeviceEnv(''), [])
  t.alike(parseDeviceEnv(null), [])
  t.alike(parseDeviceEnv(undefined), [])
})

test('applyDeviceEnv injects every entry and reports the count', (t) => {
  const injected = []
  const count = applyDeviceEnv(PUSHED_CONFIG, (key, value) => injected.push([key, value]))

  t.is(count, 3)
  t.is(injected.length, 3)
  t.alike(injected[0], ['QVAC_AUDIOGEN_GGML_BENCHMARK_DIT_VARIANT', 'sft'])
})

test('applyDeviceEnv injects nothing when the file is empty', (t) => {
  let calls = 0
  t.is(
    applyDeviceEnv('', () => calls++),
    0
  )
  t.is(calls, 0, 'desktop, where no config file exists, is a no-op')
})
