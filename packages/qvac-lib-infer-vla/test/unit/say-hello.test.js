'use strict'

const test = require('brittle')
const { sayHello } = require('../..')

test('sayHello returns greeting with default name', (t) => {
  t.is(sayHello(), 'hello, world')
})

test('sayHello returns greeting with custom name', (t) => {
  t.is(sayHello('qvac'), 'hello, qvac')
})
