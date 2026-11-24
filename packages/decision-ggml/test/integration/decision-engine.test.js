'use strict'

const os = require('bare-os')
const path = require('bare-path')
const { DecisionEngine, DECISION_INVALID_REQUEST } = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')

// Upstream decision models through DecisionEngine (upstream server-context,
// in-process), on the tiny fixtures llama-server's own /v1/systemone tests use:
// tinylaya (non-causal, marker readout) and tinyopenjev (label logits, shared
// prefixes, image projector).

const NO_MODEL = '/nonexistent/decision.gguf'
const LAYA = 'tinylaya-for-testing-Q8_0.gguf'
const OPENJEV = 'tinyopenjev-for-testing-Q8_0.gguf'
const OPENJEV_MMPROJ = 'mmproj-tinyopenjev-for-testing-Q8_0.gguf'

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'

const CPU = { device: 'cpu' }
// As the other embed tests: these runners load on the CPU.
const GPU = isDarwinX64 || isLinuxArm64 || isMobile ? CPU : { device: 'gpu', gpu_layers: '99' }

const QUESTIONS = {
  route: {
    type: 'choice',
    instructions: 'Choose the team that should handle this request.',
    criteria: {
      support: 'Account, order, and delivery questions',
      billing: 'Payments, invoices, and refunds'
    }
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this?',
    criteria: ['not urgent', 'somewhat urgent', 'very urgent']
  },
  refund: { type: 'noul', instructions: 'Does the customer ask for a refund?' }
}
const STATE = 'My payment failed twice and I was charged both times. Please refund the duplicate.'

async function modelPath(name) {
  const [file, dir] = await ensureModel({ modelName: name })
  return path.join(dir, file)
}

async function withEngine(t, name, config, fn, opts = { stats: true }) {
  const engine = new DecisionEngine({ files: { model: [await modelPath(name)] }, config, opts })
  try {
    await engine.load()
    return await fn(engine)
  } finally {
    await engine.unload().catch((err) => t.comment(`unload failed: ${err.message}`))
  }
}

async function decide(engine, request) {
  const response = await engine.run(request)
  const [result] = await response.await()
  return { result, stats: response.stats }
}

function nested(depth) {
  return JSON.parse('['.repeat(depth) + ']'.repeat(depth))
}

function checkAnswers(t, answers) {
  const { route, urgency, refund } = answers
  t.is(route.type, 'choice')
  t.ok(['support', 'billing'].includes(route.choice), `choice is an option key: ${route.choice}`)
  const total = Object.values(route.probabilities).reduce((sum, p) => sum + p, 0)
  t.ok(Math.abs(total - 1) < 1e-6, `choice probabilities sum to 1: ${total}`)
  t.ok(typeof route.confidence === 'number', 'choice has a confidence')

  t.is(urgency.type, 'score')
  t.ok(urgency.score >= 0 && urgency.score <= 2, `expected level in range: ${urgency.score}`)
  t.alike(Object.keys(urgency.legend), ['0', '1', '2'], 'legend keyed by level index')
  t.ok(typeof urgency.confidence === 'number', 'score has a confidence')

  t.is(refund.type, 'noul')
  t.ok(refund.noul >= 0 && refund.noul <= 1, `noul in range: ${refund.noul}`)
  t.absent('confidence' in refund, 'upstream noul has no confidence')
}

for (const [name, mmproj, expectType] of [
  [LAYA, null, 'laya'],
  [OPENJEV, OPENJEV_MMPROJ, 'openjev']
]) {
  safeTest(`${expectType}: answers choice, score and noul`, { timeout: 600_000 }, async (t) => {
    const config = mmproj ? { ...GPU, mmproj: await modelPath(mmproj) } : GPU
    await withEngine(t, name, config, async (engine) => {
      const info = engine.info()
      t.is(info.decision_type, expectType)
      t.is(info.noul, 'probability')
      t.alike(info.score_levels, { min: 2, max: 10 })
      t.is(info.score, 'expected_level')
      t.is(info.max_json_depth, 128)
      if (expectType === 'laya') {
        t.ok(
          info.max_input_tokens > 0 && info.max_input_tokens <= 2048,
          `one pass of at most 2048 tokens: ${info.max_input_tokens}`
        )
      } else {
        // 4 default slots share the cache: each is promised a quarter of it.
        t.is(
          info.max_input_tokens,
          Math.floor(info.n_ctx / 4) - 1,
          "causal: a slot's share of the context but one token"
        )
      }
      if (mmproj) t.ok(info.images, 'openjev with its projector takes images')

      const { result, stats } = await decide(engine, { state: STATE, questions: QUESTIONS })
      checkAnswers(t, result.answers)
      t.ok(result.usage.input_tokens > 0, 'usage counts input tokens')
      t.is(result.usage.output_tokens, 0)
      t.ok(stats.decision_input_tokens > 0, 'stats carry the input tokens')
    })
  })
}

const STATES = [
  STATE,
  'Where is my parcel? It was due on Monday.',
  'I want my money back for the broken headphones.',
  'How do I change the email address on my account?',
  'The invoice shows the wrong company name.'
]

for (const [name, expectType] of [
  [LAYA, 'laya'],
  [OPENJEV, 'openjev']
]) {
  safeTest(
    `${expectType}: a batch answers every state in input order`,
    { timeout: 600_000 },
    async (t) => {
      await withEngine(t, name, GPU, async (engine) => {
        const response = await engine.run({ states: STATES, questions: QUESTIONS })
        const [results] = await response.await()
        t.is(results.length, STATES.length, 'one result per state')
        t.is(
          response.stats.decision_input_tokens,
          results.reduce((sum, r) => sum + r.usage.input_tokens, 0),
          "stats carry the batch's input tokens, summed over its states"
        )
        for (let i = 0; i < STATES.length; i++) {
          checkAnswers(t, results[i].answers)
          const { result: alone } = await decide(engine, { state: STATES[i], questions: QUESTIONS })
          t.is(
            results[i].answers.route.choice,
            alone.answers.route.choice,
            `states[${i}]: same choice as alone`
          )
          t.ok(
            Math.abs(results[i].answers.refund.noul - alone.answers.refund.noul) < 1e-3,
            `states[${i}]: same noul as alone, to rounding`
          )
          t.is(
            results[i].usage.input_tokens,
            alone.usage.input_tokens,
            `states[${i}]: same input tokens`
          )
        }
      })
    }
  )
}

safeTest('a batch with a rejected state fails naming it', { timeout: 600_000 }, async (t) => {
  await withEngine(t, OPENJEV, GPU, async (engine) => {
    // openjev needs a state: null is rejected for that one.
    const response = await engine.run({
      states: [STATES[0], null, STATES[1]],
      questions: QUESTIONS
    })
    const rejected = await response.await().catch((err) => err)
    t.is(rejected.code, DECISION_INVALID_REQUEST, 'rejection is coded as an invalid request')
    t.ok(/^states\[1\]: /.test(rejected.message), `names states[1]: ${rejected.message}`)
    const { result } = await decide(engine, { state: STATE, questions: QUESTIONS })
    checkAnswers(t, result.answers)
  })
})

// A 32x32 RGB PNG.
const IMAGE =
  'data:image/png;base64,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'

// PNGs that hold only a header declaring 2000x2000 (4 MP) and 10000x10000
// (100 MP) pixels: the limits are checked from the header, before decoding.
const PNG_HEADER_2000 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAB9AAAAfQCAIAAAAVWlMuAAAAAElFTkSuQmCC'
const PNG_HEADER_10000 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAJxAAACcQCAIAAAA1LPVwAAAAAElFTkSuQmCC'

safeTest(
  'a CPU engine with a projector answers about an image',
  { timeout: 600_000 },
  async (t) => {
    // device: 'cpu' also keeps the projector off the GPU (mmproj_use_gpu false).
    const config = { device: 'cpu', mmproj: await modelPath(OPENJEV_MMPROJ) }
    await withEngine(t, OPENJEV, config, async (engine) => {
      t.ok(engine.info().images, 'the projector is loaded')
      const { result } = await decide(engine, {
        state: 'What does the picture show?',
        files: [IMAGE],
        questions: { colorful: { type: 'noul', instructions: 'Is the image colorful?' } }
      })
      t.is(result.answers.colorful.type, 'noul')
      t.ok(result.usage.input_tokens > 0)

      // Over the default 50 MP: rejected from the header, before decoding.
      const huge = await decide(engine, {
        state: 'What does the picture show?',
        files: [PNG_HEADER_10000],
        questions: { colorful: { type: 'noul', instructions: 'Is the image colorful?' } }
      }).catch((err) => err)
      t.is(huge.code, DECISION_INVALID_REQUEST, `100 MP image rejected: ${huge.message}`)
      t.ok(/image is larger than the media size limit/.test(huge.message), huge.message)
    })
  }
)

safeTest(
  'image_max_megapixels limits the images a request may carry',
  { timeout: 600_000 },
  async (t) => {
    const config = {
      device: 'cpu',
      mmproj: await modelPath(OPENJEV_MMPROJ),
      image_max_megapixels: '1'
    }
    await withEngine(t, OPENJEV, config, async (engine) => {
      const question = { colorful: { type: 'noul', instructions: 'Is the image colorful?' } }
      const { result } = await decide(engine, {
        state: 'What does the picture show?',
        files: [IMAGE],
        questions: question
      })
      t.is(result.answers.colorful.type, 'noul', 'a 32x32 image is within 1 MP')
      const over = await decide(engine, {
        state: 'What does the picture show?',
        files: [PNG_HEADER_2000],
        questions: question
      }).catch((err) => err)
      t.is(over.code, DECISION_INVALID_REQUEST, `4 MP image rejected: ${over.message}`)
      t.ok(/image is larger than the media size limit/.test(over.message), over.message)
    })
  }
)

safeTest(
  'rejections come back as invalid requests, and the engine keeps working',
  { timeout: 600_000 },
  async (t) => {
    await withEngine(t, OPENJEV, GPU, async (engine) => {
      const tooManyLevels = {
        state: 'x',
        questions: { q: { type: 'score', instructions: '?', criteria: 'abcdefghijk'.split('') } }
      }
      const rejected = await decide(engine, tooManyLevels).catch((err) => err)
      t.ok(/2 to 10 levels/.test(rejected.message), `11 score levels rejected: ${rejected.message}`)
      t.is(rejected.code, DECISION_INVALID_REQUEST, 'rejection is coded as an invalid request')

      // Upstream reads a question's type with json_value(), which catches the
      // runtime's common_json_error for a value of the wrong type and uses the
      // default (no type), so upstream's own check names the question. Were
      // that catch to miss the runtime's type_info (compared by address on
      // Linux and Intel macOS), the raw JSON type error would come back
      // instead.
      const wrongType = await decide(engine, {
        state: 'x',
        questions: { q: { type: 7, instructions: '?', criteria: { a: 'A', b: 'B' } } }
      }).catch((err) => err)
      t.ok(
        /questions\.q: "type" must be one of/.test(wrongType.message),
        `a numeric question type falls back to upstream's default: ${wrongType.message}`
      )
      t.is(
        wrongType.code,
        DECISION_INVALID_REQUEST,
        'a numeric question type is an invalid request'
      )

      // The depth guard counts from where each value starts: a state, the
      // instructions and an option description all pass it at 128 nested
      // levels and are rejected at 129 before any recursive code runs.
      // Upstream counts its own 128 levels from the prompt input it builds,
      // so it may reject a value nested in it a few levels sooner, as an
      // invalid request.
      const GUARD = /a value in the request is nested more than 128 levels deep/
      const placements = {
        state: (v) => ({
          state: v,
          questions: { q: { type: 'noul', instructions: 'Is it empty?' } }
        }),
        instructions: (v) => ({ state: 'x', questions: { q: { type: 'noul', instructions: v } } }),
        description: (v) => ({
          state: 'x',
          questions: { q: { type: 'choice', instructions: '?', criteria: { a: v, b: 'B' } } }
        })
      }
      for (const [name, request] of Object.entries(placements)) {
        await decide(engine, request(nested(128))).then(
          () => t.pass(`${name} at depth 128 passes the guard`),
          (err) => {
            t.absent(
              GUARD.test(err.message),
              `${name} at depth 128 not rejected by the guard: ${err.message}`
            )
            t.is(err.code, DECISION_INVALID_REQUEST, `${name} at depth 128: ${err.message}`)
          }
        )
        await t.exception(
          decide(engine, request(nested(129))),
          GUARD,
          `${name} at depth 129 rejected`
        )
      }
      await t.exception(
        decide(engine, placements.state(nested(5000))),
        GUARD,
        'depth 5000 rejected without a crash'
      )

      const { result } = await decide(engine, { state: STATE, questions: QUESTIONS })
      checkAnswers(t, result.answers)
    })
  }
)

safeTest('cancel during a run, then a successful run', { timeout: 600_000 }, async (t) => {
  await withEngine(t, OPENJEV, GPU, async (engine) => {
    const response = await engine.run({ state: STATE, questions: QUESTIONS })
    await engine.cancel()
    await response.await().then(
      () => t.pass('the run finished before the cancel landed'),
      (err) => t.ok(/cancel/i.test(err.message), `cancelled: ${err.message}`)
    )
    const { result } = await decide(engine, { state: STATE, questions: QUESTIONS })
    checkAnswers(t, result.answers)
  })
})

safeTest('unload during a run returns and frees the engine', { timeout: 600_000 }, async (t) => {
  const engine = new DecisionEngine({ files: { model: [await modelPath(OPENJEV)] }, config: GPU })
  await engine.load()
  const response = await engine.run({ state: STATE, questions: QUESTIONS })
  await engine.unload()
  await response.await().then(
    () => t.pass('the run finished before unload'),
    (err) => t.ok(err instanceof Error, `the run ended with: ${err.message}`)
  )
})

safeTest(
  'a model without decision metadata is rejected at load',
  { timeout: 600_000 },
  async (t) => {
    const engine = new DecisionEngine({
      files: { model: [await modelPath('jina-reranker-v1-tiny-en-f16.gguf')] },
      config: CPU
    })
    await t.exception(engine.load(), /not a decision model/)
  }
)

safeTest('unknown load options are rejected before the model is read', async (t) => {
  const engine = new DecisionEngine({
    files: { model: [NO_MODEL] },
    config: { device: 'cpu', pooling: 'mean' }
  })
  await t.exception(engine.load(), /pooling/)
})
