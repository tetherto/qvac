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

const PASSING_BODY = [
  { call: { method: 'fine', as: 'value' } },
  { assert: { on: '$value', use: 'expectation' } }
]

test('endTest runs once after a passing body', async () => {
  const seen = []
  const result = await run(PASSING_BODY, {
    call: async (method) => (seen.push(method), 'text'),
    endTest: async () => {
      seen.push('endTest')
    }
  })
  assert.equal(result.passed, true)
  assert.deepEqual(seen, ['fine', 'endTest'])
})

test('endTest runs after a failing body and teardown, and keeps the body diagnosis', async () => {
  const seen = []
  const result = await run(
    [{ call: { method: 'boom' } }],
    {
      call: async (method) => {
        seen.push(method)
        if (method === 'boom') throw new Error('body blew up')
        return 'ok'
      },
      endTest: async () => {
        seen.push('endTest')
      }
    },
    { finally: [{ call: { method: 'cleanup' } }] }
  )
  assert.equal(result.passed, false)
  assert.match(result.output, /body blew up/)
  assert.deepEqual(seen, ['boom', 'cleanup', 'endTest'])
})

test('endTest runs when the run throws, and the original error propagates', async () => {
  let ended = 0
  const interpreter = new StepInterpreter(
    bindings({
      evictAllExcept: async () => {
        throw new Error('evict blew up')
      },
      endTest: async () => {
        ended++
        throw new Error('release blew up')
      }
    })
  )
  await assert.rejects(interpreter.run(definition(PASSING_BODY)), /evict blew up/)
  assert.equal(ended, 1)
})

test('endTest waits for calls the body started and never settled', async () => {
  const seen = []
  const result = await run([{ start: { method: 'slow', as: 'pending' } }, ...PASSING_BODY], {
    call: (method) =>
      method === 'slow'
        ? new Promise((resolve) =>
            setTimeout(() => {
              seen.push('slow settled')
              resolve('late')
            }, 30)
          )
        : Promise.resolve('text'),
    endTest: async () => {
      seen.push('endTest')
    }
  })
  assert.equal(result.passed, true)
  assert.deepEqual(seen, ['slow settled', 'endTest'])
})

test('a failing endTest fails a passing body', async () => {
  const result = await run(PASSING_BODY, {
    call: async () => 'text',
    endTest: async () => {
      throw new Error('release blew up')
    }
  })
  assert.equal(result.passed, false)
  assert.match(result.output, /end-of-test release failed: release blew up/)
})

test('a failing endTest keeps a failing body diagnosis', async () => {
  const result = await run([{ call: { method: 'boom' } }], {
    call: async () => {
      throw new Error('body blew up')
    },
    endTest: async () => {
      throw new Error('release blew up')
    }
  })
  assert.equal(result.passed, false)
  assert.match(result.output, /body blew up \[end-of-test release also failed: release blew up\]/)
})

test('a definition without steps does not reach endTest', async () => {
  let ended = 0
  const result = await new StepInterpreter(
    bindings({
      endTest: async () => {
        ended++
      }
    })
  ).run(definition([]))
  assert.equal(result.incomplete, true)
  assert.equal(ended, 0)
})

test('a run superseded by a newer one skips endTest', async () => {
  const ended = []
  let release
  const interpreter = new StepInterpreter(
    bindings({
      call: (method) =>
        method === 'hang' ? new Promise((resolve) => (release = resolve)) : Promise.resolve('text'),
      endTest: async () => {
        ended.push('endTest')
      }
    })
  )
  const abandoned = interpreter.run(
    definition([{ call: { method: 'hang', as: 'value' } }, ...PASSING_BODY.slice(1)])
  )
  await new Promise((resolve) => setImmediate(resolve))
  const newer = await interpreter.run(definition(PASSING_BODY))
  assert.equal(newer.passed, true)
  assert.deepEqual(ended, ['endTest'])
  release('late')
  await abandoned
  assert.deepEqual(ended, ['endTest'], 'the abandoned run must not release the newer run')
})
