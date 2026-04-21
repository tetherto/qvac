'use strict'

const binding = require('./binding')

function sayHello (name) {
  return binding.sayHello(String(name ?? 'world'))
}

module.exports = { sayHello }
