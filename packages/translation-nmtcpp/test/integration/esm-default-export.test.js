'use strict'

const test = require('brittle')

// Guards the CJS→ESM interop surface: the SDK's nmtcpp-translation plugin
// consumes this package as `import TranslationNmtcpp from
// '@qvac/translation-nmtcpp'` (a default import of a CJS module), which must
// resolve to the bare class that `module.exports` is assigned to. Runtime
// interop behavior cannot be verified by the type-level consumer tests (the
// declarations can be correct while the module lexer disagrees — see the
// vla-ggml 0.16.0 → 0.16.1 named-export regression), so this exercises the
// real dynamic-import machinery.
test('ESM default export resolves to the TranslationNmtcpp class', async (t) => {
  const ns = await import('../../index.js')

  t.is(typeof ns.default, 'function', 'default export is a function')
  t.is(ns.default.name, 'TranslationNmtcpp', 'default export is the class')
  t.ok(ns.default.ModelTypes, 'class statics reachable via default export')
  t.is(ns.default.ModelTypes.Bergamot, 'Bergamot', 'ModelTypes intact')
})

// Same interop guard for the `./addonLogging` subpath, which the SDK consumes
// as `import nmtAddonLogging from '@qvac/translation-nmtcpp/addonLogging'`.
// The NAMED bindings matter independently of the default: cjs-module-lexer has
// to statically discover `setLogger`/`releaseLogger` for `import { setLogger }`
// to link at all. A previous emit shape (a bare `module.exports = obj` override
// with no `exports.X =` statements) left the lexer with an EMPTY named surface,
// so named imports threw SyntaxError at link time even though the runtime
// object had both keys.
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
