import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StepInterpreter, StepIncompleteError } from '../../dist/core/step-interpreter.js'

const EXPECT_STRING = { validation: 'type', expectedType: 'string' }

function definition(steps, extra = {}) {
  return {
    testId: 'unit',
    params: {},
    expectation: EXPECT_STRING,
    metadata: { category: 'unit' },
    steps,
    ...extra
  }
}

function bindings(overrides = {}) {
  return {
    useModel: async (deps) => deps.map((dep) => `id-${dep}`),
    call: async () => 'ok',
    ...overrides
  }
}

const run = (steps, over = {}, extra = {}) =>
  new StepInterpreter(bindings(over)).run(definition(steps, extra))

test('a body that asserts nothing is not a pass', async () => {
  const result = await run([{ call: { method: 'noop' } }])
  assert.equal(result.passed, false)
})

test('$model is bound from the first declared dep', async () => {
  const seen = []
  const result = await run(
    [
      { useModel: { deps: ['llm'] } },
      { call: { method: 'completion', params: { modelId: '$model' } } },
      { assert: { on: '$result', use: 'expectation' } }
    ],
    {
      call: async (_m, params) => {
        seen.push(params.modelId)
        return 'text'
      }
    }
  )
  assert.equal(result.passed, true)
  assert.deepEqual(seen, ['id-llm'])
})

test('an optional reference that is missing is left out of the call', async () => {
  let params
  await run(
    [
      { call: { method: 'completion', params: { a: '$params.given?', b: '$params.absent?' } } },
      { assert: { on: '$result', use: 'expectation' } }
    ],
    { call: async (_m, p) => ((params = p), 'text') },
    { params: { given: 1 } }
  )
  assert.deepEqual(params, { a: 1 })
})

test('a required reference that is missing fails the test', async () => {
  const result = await run([{ call: { method: 'completion', params: { a: '$nope' } } }])
  assert.equal(result.passed, false)
  assert.equal(result.incomplete, undefined)
})

test('project walks indexes and [*]', async () => {
  const value = { blocks: [{ text: 'a' }, { text: 'b' }] }
  const result = await run(
    [
      { call: { method: 'ocr', as: 'page' } },
      { project: { from: '$page', path: 'blocks[*].text', join: '', as: 'joined' } },
      { assert: { on: '$joined', use: 'expectation' } }
    ],
    { call: async () => value }
  )
  assert.equal(result.passed, true)
  assert.equal(result.assertedValue, 'ab')
})

test('an unimplemented binding is incomplete, not a failure', async () => {
  const result = await run([{ asset: { kind: 'audio', file: 'a.wav', as: 'a' } }])
  assert.equal(result.incomplete, true)
  assert.match(result.incompleteReason, /assets/)
})

test('a binding gap inside callError stays incomplete', async () => {
  const result = await run(
    [{ callError: { method: 'nope', as: 'err' } }, { assert: { on: '$err', use: 'expectation' } }],
    {
      call: async () => {
        throw new StepIncompleteError('no run handle for nope')
      }
    }
  )
  assert.equal(result.incomplete, true)
})

test('a binding gap inside settle expect:reject stays incomplete', async () => {
  const result = await run(
    [
      { start: { method: 'nope', as: 'pending' } },
      { settle: { of: '$pending', expect: 'reject', as: 'err' } },
      { assert: { on: '$err', use: 'expectation' } }
    ],
    {
      call: async () => {
        throw new StepIncompleteError('no run handle for nope')
      }
    }
  )
  assert.equal(result.incomplete, true, 'a gap must not be bound as the rejection under test')
})

test('settle expect:reject binds a real rejection', async () => {
  const result = await run(
    [
      { start: { method: 'boom', as: 'pending' } },
      { settle: { of: '$pending', expect: 'reject', as: 'err' } },
      { project: { from: '$err', path: 'message', as: 'message' } },
      { assert: { on: '$message', use: 'expectation' } }
    ],
    {
      call: async () => {
        throw Object.assign(new Error('refused'), { code: 42 })
      }
    }
  )
  assert.equal(result.passed, true)
  assert.equal(result.assertedValue, 'refused')
})

test('settle withinMs fails a call that does not settle in time', async () => {
  const result = await run(
    [
      { start: { method: 'slow', as: 'pending' } },
      { settle: { of: '$pending', withinMs: 20, as: 'value' } },
      { assert: { on: '$value', use: 'expectation' } }
    ],
    {
      call: () => new Promise((resolve) => setTimeout(() => resolve('late'), 60))
    }
  )
  assert.equal(result.passed, false)
  assert.match(result.output, /\$pending did not settle within 20ms/)
})

test('settle withinMs lets a call that settles in time through', async () => {
  const result = await run([
    { start: { method: 'fast', as: 'pending' } },
    { settle: { of: '$pending', withinMs: 1000, as: 'value' } },
    { assert: { on: '$value', use: 'expectation' } }
  ])
  assert.equal(result.passed, true)
})

test('callError fails when the call succeeds', async () => {
  const result = await run([{ callError: { method: 'fine', as: 'err' } }])
  assert.equal(result.passed, false)
  assert.equal(result.incomplete, undefined)
  assert.match(result.output, /expected to fail/)
})

test('repeat gives each iteration its own scope and collects the last binding', async () => {
  const result = await run(
    [
      {
        repeat: {
          over: '$params.texts',
          as: 'text',
          collectInto: 'all',
          steps: [{ call: { method: 'embed', params: { text: '$text' }, as: 'vector' } }]
        }
      },
      { project: { from: '$all', path: '[*]', join: ',', as: 'joined' } },
      { assert: { on: '$joined', use: 'expectation' } }
    ],
    { call: async (_m, p) => `v:${p.text}` },
    { params: { texts: ['a', 'b'] } }
  )
  assert.equal(result.passed, true)
  assert.equal(result.assertedValue, 'v:a,v:b')
})

test('the first failing check decides, not the last', async () => {
  const result = await run(
    [
      { call: { method: 'completion', as: 'value' } },
      { assert: { on: '$value', use: 'expectation' } },
      { assert: { on: '$value', use: 'expectation' } }
    ],
    { call: async () => 7 }
  )
  assert.equal(result.passed, false)
})

test('teardown runs after a failing body and keeps the body diagnosis', async () => {
  const seen = []
  const result = await run(
    [{ call: { method: 'boom' } }],
    {
      call: async (method) => {
        seen.push(method)
        if (method === 'boom') throw new Error('body blew up')
        return 'ok'
      }
    },
    { finally: [{ call: { method: 'cleanup' } }] }
  )
  assert.deepEqual(seen, ['boom', 'cleanup'])
  assert.match(result.output, /body blew up/)
})

test('a failing teardown fails a passing body', async () => {
  const result = await run(
    [{ call: { method: 'fine', as: 'value' } }, { assert: { on: '$value', use: 'expectation' } }],
    {
      call: async (method) => {
        if (method === 'cleanup') throw new Error('cleanup blew up')
        return 'text'
      }
    },
    { finally: [{ call: { method: 'cleanup' } }] }
  )
  assert.equal(result.passed, false)
  assert.match(result.output, /teardown failed/)
})

test('a named assertion that the client does not have is incomplete', async () => {
  const result = await run([
    { call: { method: 'fine', as: 'value' } },
    { assert: { on: '$value', named: 'somethingSpecific' } }
  ])
  assert.equal(result.incomplete, true)
})
