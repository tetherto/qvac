const test = require('brittle')
const addon = require('../../index.js')

// Ported from tests/integration_js/js-create-double-first-call/test.js so the
// js::Number / js_create_int32 marshalling helpers are exercised on-device
// (iOS/Android) as well as on desktop. Pure in-process C++/JS marshalling — no
// threads, no I/O, no timing — so it is safe to run through the mobile harness.

test('first js::Number double returns the requested value', function (t) {
  t.is(addon.createDouble(2), 2, 'first js::Number double returns 2')
  t.is(addon.createDouble(3), 3, 'second js::Number double returns 3')
})

test('first js_create_int32 returns the requested value', function (t) {
  t.is(addon.createInt32(2), 2, 'first js_create_int32 returns 2')
  t.is(addon.createInt32(3), 3, 'second js_create_int32 returns 3')
})
