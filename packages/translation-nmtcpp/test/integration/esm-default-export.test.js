'use strict'

const test = require('brittle')

// The SDK default-imports this package; the default must resolve to the class
// `module.exports` is assigned to. Only a runtime import verifies interop.
test('ESM default export resolves to the TranslationNmtcpp class', async (t) => {
  const ns = await import('../../index.js')

  t.is(typeof ns.default, 'function', 'default export is a function')
  t.is(ns.default.name, 'TranslationNmtcpp', 'default export is the class')
  t.ok(ns.default.ModelTypes, 'class statics reachable via default export')
  t.is(ns.default.ModelTypes.Bergamot, 'Bergamot', 'ModelTypes intact')
})

// Same guard for the `./addonLogging` subpath (SDK default-imports it); named
// bindings additionally need cjs-module-lexer to see `exports.X =` statements.
test('ESM interop exposes addonLogging default and named bindings', async (t) => {
  const ns = await import('../../addonLogging.js')

  t.is(typeof ns.default, 'object', 'default export is the addonLogging object')
  t.is(typeof ns.default.setLogger, 'function', 'default.setLogger is a function')
  t.is(typeof ns.default.releaseLogger, 'function', 'default.releaseLogger is a function')

  t.is(typeof ns.setLogger, 'function', 'named setLogger binding links')
  t.is(typeof ns.releaseLogger, 'function', 'named releaseLogger binding links')

  t.is(ns.setLogger, ns.default.setLogger, 'named setLogger === default.setLogger')
  t.is(ns.releaseLogger, ns.default.releaseLogger, 'named releaseLogger === default.releaseLogger')
})
