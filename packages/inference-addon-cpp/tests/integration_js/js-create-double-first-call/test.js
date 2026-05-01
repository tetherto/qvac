const test = require('brittle')
const addon = require('.')

test('first js::Number double returns the requested value', function (t) {
  t.is(addon.createDouble(2), 2, 'first js::Number double returns 2')
  t.is(addon.createDouble(3), 3, 'second js::Number double returns 3')
})

test('first js_create_int32 returns the requested value', function (t) {
  t.is(addon.createInt32(2), 2, 'first js_create_int32 returns 2')
  t.is(addon.createInt32(3), 3, 'second js_create_int32 returns 3')
})
