// AUTO-GENERATED FROM THE DESKTOP SUITE — DO NOT EDIT.
//
// Source: tests/integration_js/js-create-double-first-call/test.js
// Regenerate: npm run test:mobile:generate   (verify: npm run test:mobile:validate)
//
// Only mechanical change from the source: `require('.')` is repointed at the
// unified mobile addon, because the mobile harness runs one aggregated addon
// instead of the three standalone desktop sub-packages.
const test = require('brittle')
const addon = require('../../../index.js')

test('first js::Number double returns the requested value', function (t) {
  t.is(addon.createDouble(2), 2, 'first js::Number double returns 2')
  t.is(addon.createDouble(3), 3, 'second js::Number double returns 3')
})

test('first js_create_int32 returns the requested value', function (t) {
  t.is(addon.createInt32(2), 2, 'first js_create_int32 returns 2')
  t.is(addon.createInt32(3), 3, 'second js_create_int32 returns 3')
})
