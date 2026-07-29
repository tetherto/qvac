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
