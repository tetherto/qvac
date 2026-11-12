'use strict'

const test = require('brittle')
const { assessFit } = require('../..')

const MODEL = '/models/bridgedepth.gguf'

test('assessFit rejects a missing or relative model path before loading the binding', async (t) => {
  const pending = assessFit({ modelPath: 'bridgedepth.gguf' })
  t.ok(pending instanceof Promise, 'an invalid request rejects')
  await t.exception.all(pending, /modelPath must be an absolute path/)
  await t.exception.all(assessFit({}), /modelPath must be an absolute path/)
  await t.exception.all(assessFit(), /modelPath must be an absolute path/)
})

test('assessFit rejects a path with a NUL character before loading the binding', async (t) => {
  await t.exception.all(
    assessFit({ modelPath: '/models/a\0b.gguf' }),
    /modelPath must not contain a NUL character/
  )
  await t.exception.all(
    assessFit({ modelPath: MODEL, backendsDir: '/backends\0' }),
    /backendsDir must not contain a NUL character/
  )
  await t.exception.all(
    assessFit({ modelPath: MODEL, backend: 'MTL0\0junk' }),
    /backend must not contain a NUL character/
  )
})

test('assessFit rejects options of the wrong type before loading the binding', async (t) => {
  await t.exception.all(assessFit({ modelPath: MODEL, backend: 5 }), /backend must be a string/)
  await t.exception.all(
    assessFit({ modelPath: MODEL, backendsDir: 5 }),
    /backendsDir must be a string/
  )
  await t.exception.all(assessFit({ modelPath: MODEL, workload: 7 }), /workload must be an object/)
})

test('assessFit rejects invalid memory margins before loading the binding', async (t) => {
  for (const marginBytes of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1']) {
    await t.exception.all(
      assessFit({ modelPath: MODEL, marginBytes }),
      /marginBytes must be a non-negative safe integer/
    )
  }
})

test('assessFit rejects invalid thread counts before loading the binding', async (t) => {
  for (const threads of [0, -1, 1.5, NaN, Infinity, 1025]) {
    await t.exception.all(
      assessFit({ modelPath: MODEL, threads }),
      /threads must be an integer between 1 and 1024/
    )
  }
})

test('assessFit rejects invalid workload sizes before loading the binding', async (t) => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await t.exception.all(
      assessFit({ modelPath: MODEL, workload: { width: value } }),
      /workload.width must be a positive safe integer/
    )
    await t.exception.all(
      assessFit({ modelPath: MODEL, workload: { height: value } }),
      /workload.height must be a positive safe integer/
    )
  }
})

test('assessFit is exported from the package entry point', (t) => {
  const pkg = require('../..')
  t.is(typeof pkg.assessFit, 'function')
  t.is(pkg.assessFit, assessFit)
})
