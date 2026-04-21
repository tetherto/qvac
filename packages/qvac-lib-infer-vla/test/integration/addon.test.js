'use strict'

const test = require('brittle')
const { sayHello } = require('../..')

test('integration: addon loads and returns greeting', (t) => {
  const out = sayHello('integration')
  t.is(typeof out, 'string')
  t.is(out, 'hello, integration')
})

test('integration: addon handles default argument', (t) => {
  t.is(sayHello(), 'hello, world')
})
