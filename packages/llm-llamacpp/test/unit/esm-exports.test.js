'use strict'

// ESM named exports of a CommonJS module are discovered statically by
// cjs-module-lexer, which only detects top-level `exports.X =` assignments.
// Attaching members any other way links with zero named exports.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

test('ESM default import resolves to the LlmLlamacpp class', async (t) => {
  const ns = await import('../../index.js')

  t.is(typeof ns.default, 'function', 'default export is a function')
  t.is(ns.default.name, 'LlmLlamacpp', 'default export is the class')
  t.is(typeof ns.default.pickPrimaryGgufPath, 'function', 'statics reachable via default export')
  t.is(typeof ns.default.QvacResponse, 'function', 'QvacResponse re-export reachable')
})

test('ESM named bindings link and match the statics', async (t) => {
  const ns = await import('../../index.js')

  t.is(typeof ns.pickPrimaryGgufPath, 'function', 'named pickPrimaryGgufPath binding links')
  t.is(typeof ns.QvacResponse, 'function', 'named QvacResponse binding links')
  t.is(ns.pickPrimaryGgufPath, ns.default.pickPrimaryGgufPath, 'named === static')
  t.is(ns.QvacResponse, ns.default.QvacResponse, 'named === static')
})

// addonLogging.js requires the native binding at load, which the unit tier
// does not have, so its lexer visibility is asserted on the emitted file.
test('addonLogging emits the top-level assignments the lexer needs', (t) => {
  const emitted = fs.readFileSync(path.join(__dirname, '..', '..', 'addonLogging.js'), 'utf8')

  t.ok(emitted.includes('exports.setLogger = '), 'setLogger is a top-level exports assignment')
  t.ok(
    emitted.includes('exports.releaseLogger = '),
    'releaseLogger is a top-level exports assignment'
  )
  t.ok(
    emitted.includes('module.exports = addonLogging'),
    'module.exports stays the bare addonLogging object'
  )
})
