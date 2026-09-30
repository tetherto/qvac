'use strict'

const test = require('brittle')
const { checkConfig } = require('../../engines/whisper/configChecker.js')

function config(contextParams) {
  return { whisperConfig: {}, contextParams, miscConfig: {} }
}

test('main-gpu accepts raw indices, integer strings, and GPU classes', (t) => {
  for (const key of ['main-gpu', 'main_gpu']) {
    for (const value of [
      0,
      2,
      -1,
      2147483647,
      -2147483648,
      '2',
      '+2',
      '-1',
      'dedicated',
      'INTEGRATED'
    ]) {
      checkConfig(config({ [key]: value, use_gpu: true }))
      t.pass(`${key} accepts ${value}`)
    }
  }
})

test('main-gpu rejects invalid values before native loading', (t) => {
  for (const value of [
    null,
    undefined,
    true,
    {},
    [],
    1.2,
    NaN,
    Infinity,
    2147483648,
    -2147483649,
    '1.2',
    '2junk',
    ' 2',
    '+-1',
    '',
    'automatic'
  ]) {
    t.exception(() => checkConfig(config({ 'main-gpu': value })), /main-gpu/)
  }
})

test('main-gpu rejects ambiguous configuration and keeps legacy options', (t) => {
  t.exception(() => checkConfig(config({ 'main-gpu': 0, main_gpu: 0 })), /only one/)
  t.exception(() => checkConfig(config({ 'main-gpu': 0, gpu_device: 0 })), /combined/)
  t.exception(() => checkConfig(config({ main_gpu: 'integrated', gpu_device: 1 })), /combined/)
  checkConfig(config({ gpu_device: 1, use_gpu: true }))
  checkConfig(config({ 'main-gpu': 'dedicated', use_gpu: false }))
  t.pass('legacy selection and explicit CPU configuration remain valid')
})
