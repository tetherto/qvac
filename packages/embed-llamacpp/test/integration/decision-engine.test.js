'use strict'

const os = require('bare-os')
const path = require('bare-path')
const { DecisionEngine, DECISION_INVALID_REQUEST } = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')

// Upstream decision models through @qvac/fabric's qvac_fabric_decision_*
// bridge, on the tiny fixtures llama-server's own /v1/systemone tests use:
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
      t.is(info.max_json_depth, 128)
      if (mmproj) t.ok(info.images, 'openjev with its projector takes images')

      const { result, stats } = await decide(engine, { state: STATE, questions: QUESTIONS })
      checkAnswers(t, result.answers)
      t.ok(result.usage.input_tokens > 0, 'usage counts input tokens')
      t.is(result.usage.output_tokens, 0)
      t.ok(stats.decision_input_tokens > 0, 'stats carry the input tokens')
    })
  })
}

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

      // The depth guard accepts a state nested 128 deep (upstream may still
      // answer or reject it on its own terms) and rejects 129 before any
      // recursive code runs.
      const atLimit = {
        state: nested(128),
        questions: { q: { type: 'noul', instructions: 'Is it empty?' } }
      }
      await decide(engine, atLimit).then(
        () => t.pass('depth 128 passes the guard'),
        (err) =>
          t.absent(
            /levels deep/.test(err.message),
            `depth 128 not rejected by the guard: ${err.message}`
          )
      )
      const tooDeep = {
        state: nested(129),
        questions: { q: { type: 'noul', instructions: 'Is it empty?' } }
      }
      await t.exception(
        decide(engine, tooDeep),
        /nested more than 128 levels deep/,
        'depth 129 rejected'
      )
      const veryDeep = {
        state: nested(5000),
        questions: { q: { type: 'noul', instructions: 'Is it empty?' } }
      }
      await t.exception(
        decide(engine, veryDeep),
        /levels deep/,
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
