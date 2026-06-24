'use strict'

const test = require('brittle')
const { mapAddonEvent } = require('../../addon.js')

test('Array payload maps to Output regardless of event name', function (t) {
  const data = [{ label: 'food', confidence: 0.9 }]
  const result = mapAddonEvent('struct ...::ClassifyOutput', data, null)
  t.is(result.type, 'Output')
  t.is(result.data, data)
  t.is(result.error, null)
})

test('Plain non-array object maps to terminal JobEnded', function (t) {
  // Models the upstream JobRunner's stats trailer, whose RTTI event name
  // is the raw `std::vector<std::pair<...>>` — there is no literal
  // `JobEnded` substring in the event for this addon.
  const stats = { total_time_ms: 47.3 }
  const result = mapAddonEvent('class std::vector<std::pair<...>>', stats, null)
  t.is(result.type, 'JobEnded', 'shape-keyed: object → terminal')
  t.is(result.data, stats)
  t.is(result.error, null)
})

test('Event name containing "Error" maps to Error with rawError', function (t) {
  const err = new Error('boom')
  const result = mapAddonEvent('class qvac_errors::SomeError', null, err)
  t.is(result.type, 'Error')
  t.is(result.data, null)
  t.is(result.error, err)
})

test('Event name containing "LogMsg" maps to LogMsg (not Output) for string data', function (t) {
  const result = mapAddonEvent('class JsLogMsgOutputHandler', 'native log line', null)
  t.is(result.type, 'LogMsg', 'name-match wins over the Array fallback')
  t.is(result.data, 'native log line')
  t.is(result.error, null)
})

test('Event name containing "JobStarted" returns null (drop)', function (t) {
  const result = mapAddonEvent('struct ...::JobStarted', null, null)
  t.is(result, null)
})

test('Event name containing "JobEnded" maps to JobEnded (defensive name path)', function (t) {
  const result = mapAddonEvent('struct ...::JobEnded', { ok: true }, null)
  t.is(result.type, 'JobEnded')
  t.alike(result.data, { ok: true })
})

test('Unknown event with primitive data falls through preserving event name', function (t) {
  const result = mapAddonEvent('UnknownEvent', 42, null)
  t.is(result.type, 'UnknownEvent')
  t.is(result.data, 42)
  t.is(result.error, null)
})

test('Unknown event with null data falls through preserving event name', function (t) {
  const result = mapAddonEvent('UnknownEvent', null, null)
  t.is(result.type, 'UnknownEvent')
  t.is(result.data, null)
})

test('Non-string event with array data still maps to Output', function (t) {
  // Defensive: even if upstream ever emits a non-string event marker,
  // payload-shape keying keeps us safe for arrays.
  const result = mapAddonEvent(undefined, [1, 2, 3], null)
  t.is(result.type, 'Output')
  t.alike(result.data, [1, 2, 3])
})

test('Object data with a nested results array still routes to JobEnded (regression guard)', function (t) {
  // If a future C++ change wraps ClassifyOutput in `{ results: [...] }`,
  // this branch silently misclassifies it as JobEnded. The integration
  // suite would notice via classify() resolving to undefined; this unit
  // test pins down the current shape-keyed behaviour so the regression
  // is caught at the unit level, not at integration time.
  const result = mapAddonEvent('struct ...::SomeWrappedOutput', { results: [{ label: 'x', confidence: 1 }] }, null)
  t.is(result.type, 'JobEnded', 'TODAY: object data wins over inner array; revisit if upstream wraps Output in an object')
  t.alike(result.data.results, [{ label: 'x', confidence: 1 }])
})
