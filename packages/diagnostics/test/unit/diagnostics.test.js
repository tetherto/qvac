'use strict'

const test = require('brittle')
const {
  REPORT_VERSION,
  registerAddon,
  unregisterAddon,
  registerExtension,
  collectEnvironment,
  collectHardware,
  generateReport,
  serializeReport,
  reset
} = require('../..')

test('registerAddon + unregisterAddon lifecycle', t => {
  reset()
  registerAddon({ name: 'test-addon', version: '1.0.0', getDiagnostics: () => '{}' })
  const report = generateReport({ app: { name: 'app', version: '1.0.0' } })
  t.is(report.addons.length, 1, 'addon is registered')
  t.is(report.addons[0].name, 'test-addon', 'addon has correct name')

  unregisterAddon('test-addon')
  const report2 = generateReport({ app: { name: 'app', version: '1.0.0' } })
  t.is(report2.addons.length, 0, 'addon is unregistered')
})

test('getDiagnostics callback is called during generateReport()', t => {
  reset()
  let called = false
  registerAddon({
    name: 'callback-addon',
    version: '0.1.0',
    getDiagnostics: () => {
      called = true
      return '{"key":"value"}'
    }
  })
  generateReport({ app: { name: 'app', version: '1.0.0' } })
  t.ok(called, 'getDiagnostics was called during generateReport')
})

test('getDiagnostics returning a JSON string appears as-is in report.addons[].diagnostics', t => {
  reset()
  const diagnosticsStr = '{"model":"llama3","loaded":true,"layers":32}'
  registerAddon({
    name: 'json-addon',
    version: '2.0.0',
    getDiagnostics: () => diagnosticsStr
  })
  const report = generateReport({ app: { name: 'app', version: '1.0.0' } })
  t.is(report.addons[0].diagnostics, diagnosticsStr, 'diagnostics string is preserved as-is')
})

test('registerExtension appears in report.extensions', t => {
  reset()
  registerExtension('custom-section', { foo: 'bar', count: 42 })
  const report = generateReport({ app: { name: 'app', version: '1.0.0' } })
  t.is(report.extensions.length, 1, 'extension is present')
  t.is(report.extensions[0].name, 'custom-section', 'extension has correct name')
  t.alike(report.extensions[0].data, { foo: 'bar', count: 42 }, 'extension has correct data')
})

test('generateReport returns valid structure with all expected top-level fields', t => {
  reset()
  registerAddon({ name: 'struct-addon', version: '1.0.0', getDiagnostics: () => '{}' })
  registerExtension('struct-ext', { x: 1 })
  const report = generateReport({ app: { name: 'myapp', version: '3.2.1' } })

  t.ok(typeof report.reportVersion === 'string', 'reportVersion is a string')
  t.is(report.reportVersion, REPORT_VERSION, 'reportVersion matches REPORT_VERSION constant')
  t.ok(typeof report.generatedAt === 'string', 'generatedAt is a string')
  t.ok(report.app, 'app field is present')
  t.is(report.app.name, 'myapp', 'app.name is correct')
  t.is(report.app.version, '3.2.1', 'app.version is correct')
  t.ok(report.environment, 'environment field is present')
  t.ok(report.hardware, 'hardware field is present')
  t.ok(Array.isArray(report.addons), 'addons is an array')
  t.ok(Array.isArray(report.extensions), 'extensions is an array')
})

test('collectEnvironment returns os/arch/runtime strings', t => {
  const env = collectEnvironment()
  t.ok(typeof env.os === 'string', 'os is a string')
  t.ok(typeof env.arch === 'string', 'arch is a string')
  t.ok(typeof env.osVersion === 'string', 'osVersion is a string')
  t.ok(typeof env.runtime === 'string', 'runtime is a string')
  t.ok(env.os.length > 0, 'os is not empty')
  t.ok(env.arch.length > 0, 'arch is not empty')
})

test('collectHardware returns object with expected shape', t => {
  const hw = collectHardware()
  t.ok(typeof hw.cpuModel === 'string', 'cpuModel is a string')
  t.ok(typeof hw.cpuCores === 'number', 'cpuCores is a number')
  t.ok(typeof hw.totalMemoryMB === 'number', 'totalMemoryMB is a number')
})

test('serializeReport produces valid JSON', t => {
  reset()
  const report = generateReport({ app: { name: 'app', version: '1.0.0' } })
  const json = serializeReport(report)
  t.ok(typeof json === 'string', 'serializeReport returns a string')
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    t.fail('serializeReport output is not valid JSON')
    return
  }
  t.ok(parsed, 'parsed JSON is truthy')
  t.is(parsed.reportVersion, REPORT_VERSION, 'serialized report has correct reportVersion')
})

test('reset clears all state', t => {
  registerAddon({ name: 'reset-addon', version: '1.0.0', getDiagnostics: () => '{}' })
  registerExtension('reset-ext', { a: 1 })
  reset()
  const report = generateReport({ app: { name: 'app', version: '1.0.0' } })
  t.is(report.addons.length, 0, 'addons cleared after reset')
  t.is(report.extensions.length, 0, 'extensions cleared after reset')
})

test('REPORT_VERSION is a string', t => {
  t.ok(typeof REPORT_VERSION === 'string', 'REPORT_VERSION is a string')
  t.is(REPORT_VERSION, '1.0.0', 'REPORT_VERSION is 1.0.0')
})

test('registerAddon throws on invalid inputs', t => {
  t.exception(() => registerAddon(null), 'throws when addon is null')
  t.exception(() => registerAddon({}), 'throws when name is missing')
  t.exception(() => registerAddon({ name: '', version: '1.0.0', getDiagnostics: () => '{}' }), 'throws when name is empty string')
  t.exception(() => registerAddon({ name: 'a', version: 1, getDiagnostics: () => '{}' }), 'throws when version is not a string')
  t.exception(() => registerAddon({ name: 'a', version: '1.0.0', getDiagnostics: 'not-a-fn' }), 'throws when getDiagnostics is not a function')
})

test('registerExtension throws on invalid name', t => {
  t.exception(() => registerExtension('', { data: 1 }), 'throws when name is empty string')
  t.exception(() => registerExtension(42, { data: 1 }), 'throws when name is not a string')
})

test('getDiagnostics throwing is caught and error serialized into diagnostics string', t => {
  reset()
  registerAddon({
    name: 'throwing-addon',
    version: '1.0.0',
    getDiagnostics: () => { throw new Error('boom') }
  })
  const report = generateReport({ app: { name: 'app', version: '1.0.0' } })
  t.is(report.addons.length, 1, 'addon entry is present')
  const diagnostics = report.addons[0].diagnostics
  t.ok(typeof diagnostics === 'string', 'diagnostics is a string even when getDiagnostics throws')
  const parsed = JSON.parse(diagnostics)
  t.ok(parsed.error, 'error field is present in fallback diagnostics')
})
