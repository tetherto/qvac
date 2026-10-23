import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import {
  prepareHistorySource,
  assessHistoryResult,
  PREDECESSORS
} from '../diffusion-history-diagnostic.mjs'

const original = fs.readFileSync(
  new URL(
    '../../../packages/diffusion-cpp/test/integration/abot-world.test.js',
    import.meta.url
  ),
  'utf8'
)

function registrations(source) {
  const names = []
  vm.runInNewContext(source, {
    console: { log() {} },
    __dirname: '/fixture',
    require(name) {
      if (name === 'brittle') return (name) => names.push(name)
      if (name === 'bare-path') return path
      if (name === 'bare-os') return { platform: () => 'linux', arch: () => 'x64' }
      if (name === 'bare-process') return { env: {} }
      return {}
    }
  })
  return names
}

test('history replay registers exactly the original five-test prefix in order', () => {
  const selected = prepareHistorySource(original, true)
  assert.deepEqual(registrations(selected), registrations(original).slice(0, 5))
  assert.deepEqual(registrations(selected).slice(0, 2), PREDECESSORS)
  assert.equal((selected.match(/config: \{ backend: 'gpu'/g) || []).length, 3)
  assert(selected.includes('error <= 1,'))
  assert(selected.includes('residentWalks.set(lane.kvCache, run({ kvCache: lane.kvCache }))'))
})

test('control omits only the two predecessors and retains all parity lanes', () => {
  assert.deepEqual(
    registrations(prepareHistorySource(original, false)),
    registrations(original).slice(2, 5)
  )
  assert.throws(() =>
    prepareHistorySource(
      original.replace('          return blocks', '          return changed'),
      true
    )
  )
})

function log({ history = false, failed = false, comparisons = 135 } = {}) {
  const count = history ? 5 : 3
  return [
    ...['CUDA0', 'CPU', 'disk'].map((params) => `runtime=CUDA0, params=${params}`),
    ...Array.from(
      { length: comparisons },
      () => `mean pixel error ${failed ? '20.1525' : '0.0000'} <= 1/255`
    ),
    ...(failed ? ['not ok 5 - ABot-World: disk residency, KV on'] : []),
    `# tests = ${failed ? count - 1 : count}/${count} pass`,
    `# asserts = ${failed ? 145 : 181}/181 pass`
  ].join('\n')
}

test('parity failure is complete diagnostic evidence but remains a failure', () => {
  const result = assessHistoryResult(log({ history: true, failed: true }), 1, true)
  assert.equal(result.complete, true)
  assert.equal(result.passed, false)
  assert.equal(result.maxPixelError, 20.1525)
  assert.equal(result.failedTests.length, 1)
})

test('successful exit cannot mask skipped coverage, non-CUDA execution or a crash', () => {
  assert.equal(assessHistoryResult(log(), 0, false).passed, true)
  assert.equal(assessHistoryResult(log({ comparisons: 90 }), 0, false).passed, false)
  assert.equal(
    assessHistoryResult(log().replaceAll('CUDA0', 'Vulkan0'), 0, false).passed,
    false
  )
  assert.equal(assessHistoryResult(log(), null, false).passed, false)
  assert.equal(assessHistoryResult('', 0, false).passed, false)
})
