'use strict'

const test = require('brittle')
const LlmLlamacpp = require('../../index.js')

function createStub(defaultImpl = () => {}) {
  let impl = defaultImpl
  const fn = function (...args) {
    fn.called = true
    fn.callCount += 1
    fn.calls.push(args)
    fn.lastArgs = args
    return impl.apply(this, args)
  }
  fn.called = false
  fn.callCount = 0
  fn.calls = []
  fn.lastArgs = null
  fn.callsFake = (newImpl) => {
    impl = newImpl || (() => {})
    return fn
  }
  return fn
}

/// Stubbed addon so validation is reached without a real model load.
function createModel() {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'cpu', ctx_size: '256' },
    opts: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  })
  let nextId = 1
  model.addon = {
    activeJobs: () => 0,
    runJob: createStub((items) => {
      const id = nextId++
      return { accepted: true, id, ids: items.map((item, i) => item.id ?? `batch-${id}-${i}`) }
    }),
    cancel: createStub(() => Promise.resolve()),
    cancelJob: createStub(() => Promise.resolve())
  }
  return model
}

// The addon binding pulls each param it knows by name and ignores the rest of
// the object, so an unknown key used to run with the load-time default while
// looking like it had been applied. `n_predict` for `predict` is the near miss
// that actually happened.
test('run rejects unknown generationParams keys instead of dropping them', async (t) => {
  const cases = [
    ['n_predict', { n_predict: 24 }, /unknown key: n_predict/],
    ['max_tokens', { max_tokens: 24 }, /unknown key: max_tokens/],
    ['two at once', { n_predict: 24, temperature: 0.5 }, /unknown keys: n_predict, temperature/]
  ]

  for (const [label, generationParams, expected] of cases) {
    const model = createModel()

    // exception.all: TypeError is opted out of plain t.exception by brittle.
    await t.exception.all(
      () => model.run([{ role: 'user', content: 'a' }], { generationParams }),
      expected,
      `${label} must throw a TypeError naming the key`
    )
    t.is(model.addon.runJob.called, false, `a run with ${label} must never reach native admission`)
  }
})

test('the error lists the keys a caller can use', async (t) => {
  const model = createModel()
  let err = null
  try {
    await model.run([{ role: 'user', content: 'a' }], {
      generationParams: { n_predict: 24 }
    })
  } catch (caught) {
    err = caught
  }
  t.ok(err instanceof TypeError, 'unknown key must be a TypeError')
  t.ok(/Valid keys are .*\bpredict\b/.test(err.message), 'the message must name `predict`')
})

// The addon reads each param with a named get, which walks the prototype
// chain. So an own-enumerable-keys check alone leaves two ways past it: a
// non-enumerable own key, and anything reachable through the prototype,
// including a polluted `Object.prototype`.
test('generationParams validation cannot be bypassed through the prototype chain', async (t) => {
  const forwarded = (model) => model.addon.runJob.lastArgs[0][0].generationParams

  const nonEnumerable = {}
  Object.defineProperty(nonEnumerable, 'n_predict', { value: 24, enumerable: false })
  const nonEnumerableModel = createModel()
  await t.exception.all(
    () =>
      nonEnumerableModel.run([{ role: 'user', content: 'a' }], {
        generationParams: nonEnumerable
      }),
    /unknown key: n_predict/,
    'a non-enumerable own key must still be rejected'
  )
  t.is(nonEnumerableModel.addon.runJob.called, false, 'it must not reach native admission')

  // An inherited known key is not a caller intent this API exposes; honouring
  // it would let a polluted prototype set sampler config.
  const inheritedModel = createModel()
  await inheritedModel.run([{ role: 'user', content: 'a' }], {
    generationParams: Object.create({ predict: 999 })
  })
  t.is(forwarded(inheritedModel).predict, undefined, 'an inherited key must not be forwarded')

  const pollutedModel = createModel()
  Object.prototype.grammar = 'root ::= "pwned"' // eslint-disable-line no-extend-native
  t.teardown(() => {
    delete Object.prototype.grammar
  })
  await pollutedModel.run([{ role: 'user', content: 'a' }], {
    generationParams: { temp: 0 }
  })
  const params = forwarded(pollutedModel)
  t.is(params.temp, 0, "the caller's own key still arrives")
  t.is(params.grammar, undefined, 'a polluted prototype must not reach the addon')
  t.is(Object.getPrototypeOf(params), null, 'the forwarded object has nowhere else to look')
})

test('every documented generationParams key is accepted', async (t) => {
  const model = createModel()

  // `grammar` and `json_schema` are mutually exclusive, so `grammar` is
  // covered on its own below.
  await model.run([{ role: 'user', content: 'a' }], {
    generationParams: {
      temp: 0,
      top_p: 1,
      top_k: 40,
      predict: 24,
      seed: 50,
      frequency_penalty: 0,
      presence_penalty: 0,
      repeat_penalty: 1,
      json_schema: { type: 'object' },
      reasoning_budget: 0,
      remove_thinking_from_context: true
    }
  })
  t.is(model.addon.runJob.callCount, 1, 'a fully populated params object must be admitted')

  const grammarModel = createModel()
  await grammarModel.run([{ role: 'user', content: 'a' }], {
    generationParams: { grammar: 'root ::= "a"' }
  })
  t.is(grammarModel.addon.runJob.callCount, 1, 'grammar must be admitted on its own')
})
