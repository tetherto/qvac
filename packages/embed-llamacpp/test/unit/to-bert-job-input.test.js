'use strict'

const test = require('brittle')
const { toBertJobInput } = require('../../addon.js')

const jpeg = new Uint8Array([0xff, 0xd8, 0xff])
const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46])

test('a string maps to a text job', function (t) {
  t.alike(toBertJobInput('hello'), { type: 'text', input: 'hello' })
})

test('a string array maps to a sequences job', function (t) {
  t.alike(toBertJobInput(['a', 'b']), { type: 'sequences', input: ['a', 'b'] })
})

test('an empty array maps to an empty sequences job', function (t) {
  t.alike(toBertJobInput([]), { type: 'sequences', input: [] })
})

test('an array with a media part is one multimodal input in order', function (t) {
  const job = toBertJobInput(['task: search result | query: ', { media: jpeg }, ' red shoes'])
  t.is(job.type, 'multimodal')
  t.is(job.input.length, 1)
  t.alike(job.input[0], [
    { type: 'text', text: 'task: search result | query: ' },
    { type: 'media', data: jpeg },
    { type: 'text', text: ' red shoes' }
  ])
})

test('adjacent text parts are merged', function (t) {
  const job = toBertJobInput(['a', 'b', { media: wav }, 'c', 'd'])
  t.alike(job.input[0], [
    { type: 'text', text: 'ab' },
    { type: 'media', data: wav },
    { type: 'text', text: 'cd' }
  ])
})

test('{ inputs } with media yields one multimodal input per item', function (t) {
  const job = toBertJobInput({
    inputs: ['plain text', [{ media: jpeg }], ['title: none | text: ', { media: wav }]]
  })
  t.is(job.type, 'multimodal')
  t.alike(job.input, [
    [{ type: 'text', text: 'plain text' }],
    [{ type: 'media', data: jpeg }],
    [
      { type: 'text', text: 'title: none | text: ' },
      { type: 'media', data: wav }
    ]
  ])
})

test('{ inputs } without media takes the text path', function (t) {
  t.alike(toBertJobInput({ inputs: ['a', ['b', 'c']] }), { type: 'sequences', input: ['a', 'bc'] })
})

test('an invalid part is rejected with its position', function (t) {
  t.exception.all(
    () => toBertJobInput(['text', { media: 'not bytes' }]),
    /input\[1\] must be a string or \{ media: Uint8Array \}/
  )
  t.exception.all(() => toBertJobInput({ inputs: ['ok', [42]] }), /inputs\[1\]\[0\]/)
  t.exception.all(
    () => toBertJobInput({ inputs: [42] }),
    /inputs\[0\] must be a string or an array of parts/
  )
})

test('an unsupported input shape is rejected', function (t) {
  t.exception.all(
    () => toBertJobInput(42),
    /input must be a string, an array or \{ inputs: \[\.\.\.\] \}/
  )
  t.exception.all(() => toBertJobInput(null), TypeError)
  t.exception.all(() => toBertJobInput({ text: 'x' }), TypeError)
})
