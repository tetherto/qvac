'use strict'

// cjs-module-lexer discovers a CommonJS module's named exports statically and
// only detects top-level `exports.X =`; any other form links with none.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

// Every entrypoint that ships, with the named exports it must keep. Driven off
// one table so a new entrypoint cannot be added without declaring its exports.
const ENTRYPOINTS = [
  { file: 'index.js', named: ['pickPrimaryGgufPath', 'QvacResponse'] },
  { file: 'addon.js', named: ['LlamaInterface', 'mapAddonEvent'] },
  {
    file: 'batchHandler.js',
    named: ['RUN_BUSY_ERROR_MESSAGE', 'RUN_BUSY_ERROR_CODE', 'runBusyError']
  },
  { file: 'addonLogging.js', named: ['setLogger', 'releaseLogger'] }
]

for (const { file, named } of ENTRYPOINTS) {
  test(`${file} emits the top-level assignments the lexer needs`, (t) => {
    const emitted = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')
    for (const name of named) {
      // The lexer accepts either top-level form, so assert on both rather than
      // relying on `exports.X =` matching inside `module.exports.X =`.
      const assigned =
        emitted.includes(`\nexports.${name} = `) || emitted.includes(`\nmodule.exports.${name} = `)
      t.ok(assigned, `${name} is a top-level exports assignment`)
    }
  })
}

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

test('batchHandler ESM named bindings link', async (t) => {
  const ns = await import('../../batchHandler.js')

  t.is(typeof ns.default, 'function', 'default export is the BatchHandler class')
  t.is(typeof ns.RUN_BUSY_ERROR_MESSAGE, 'string', 'named RUN_BUSY_ERROR_MESSAGE binding links')
  t.is(ns.RUN_BUSY_ERROR_CODE, 'RUN_BUSY', 'named RUN_BUSY_ERROR_CODE binding links')
  t.is(typeof ns.runBusyError, 'function', 'named runBusyError binding links')
  t.is(ns.runBusyError().code, 'RUN_BUSY', 'runBusyError still builds the coded error')
})

test('addon ESM named bindings link', async (t) => {
  const ns = await import('../../addon.js')

  t.is(typeof ns.LlamaInterface, 'function', 'named LlamaInterface binding links')
  t.is(typeof ns.mapAddonEvent, 'function', 'named mapAddonEvent binding links')
})
