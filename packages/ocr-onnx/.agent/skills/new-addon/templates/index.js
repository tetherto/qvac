'use strict'

const binding = require('./binding')
const { normalizeName } = require('./addon.js')

function sayHello (name) {
  return binding.sayHello(normalizeName(name))
}

module.exports = { sayHello, normalizeName }
