'use strict'

const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const { LayaDecisions } = require('../../index.js')
const { ensureModel, ensurePrestagedLayaModel, safeTest } = require('./utils')

// Load options are checked before the file is read, so the config tests below
// need no Laya model and run everywhere.
const NO_MODEL = '/nonexistent/laya.gguf'

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'

// The Laya GGUF is not in models.manifest.json (no Hugging Face source). On
// desktop the tests that run a model read LAYA_TEST_MODEL (the variable the C++
// tests read too) and skip without it; on mobile they use the copy the Device
// Farm host pre-staged, and fail when it is missing rather than skip.
const skip = !isMobile && !process.env.LAYA_TEST_MODEL
let layaModel = null
function layaModelPath() {
  layaModel ??= process.env.LAYA_TEST_MODEL
    ? Promise.resolve(path.resolve(process.env.LAYA_TEST_MODEL))
    : ensurePrestagedLayaModel()
  return layaModel
}

const CPU = { device: 'cpu' }
// As the other embed tests: these runners load on the CPU.
const GPU = isDarwinX64 || isLinuxArm64 || isMobile ? CPU : { device: 'gpu', gpu_layers: '99' }

const QUESTIONS = {
  department: {
    type: 'choice',
    instructions: 'Which team should handle this ticket?',
    criteria: { billing: 'payments, refunds, invoices', technical: 'bugs, outages, errors' }
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this?',
    criteria: ['not urgent', 'somewhat urgent', 'very urgent']
  },
  refund: { type: 'noul', instructions: 'The customer asks for a refund.' }
}

const STATES = [
  'My payment failed twice and I was charged both times. Please refund the duplicate.',
  'The app crashes every time I open the settings page.',
  'Can I get an invoice for last month?'
]

async function withLaya(t, config, fn, opts = { stats: true }) {
  const laya = new LayaDecisions({ files: { model: [await layaModelPath()] }, config, opts })
  try {
    await laya.load()
    return await fn(laya)
  } finally {
    await laya.unload().catch((err) => t.comment(`unload failed: ${err.message}`))
  }
}

async function decide(laya, request) {
  const response = await laya.run(request)
  const [result] = await response.await()
  return { result, stats: response.stats }
}

function checkAnswers(t, answers) {
  const { department, urgency, refund } = answers

  t.is(department.type, 'choice')
  t.ok(
    ['billing', 'technical'].includes(department.choice),
    `choice is a label: ${department.choice}`
  )
  const total = Object.values(department.probabilities).reduce((sum, p) => sum + p, 0)
  t.ok(Math.abs(total - 1) < 1e-3, `choice probabilities sum to 1 (${total})`)

  t.is(urgency.type, 'score')
  t.ok(urgency.score >= 0 && urgency.score <= 2, `score is within the levels (${urgency.score})`)

  t.is(refund.type, 'noul')
  t.ok(refund.noul >= 0 && refund.noul <= 1, `noul is a probability (${refund.noul})`)
}

safeTest(
  'a single state is answered for every question type',
  { skip, timeout: 600_000 },
  async (t) => {
    await withLaya(t, GPU, async (laya) => {
      const { result, stats } = await decide(laya, { state: STATES[0], questions: QUESTIONS })

      t.alike(Object.keys(result.answers).sort(), ['department', 'refund', 'urgency'])
      checkAnswers(t, result.answers)
      t.is(result.answers.department.choice, 'billing', 'a refund ticket goes to billing')
      t.ok(
        result.answers.refund.noul > 0.5,
        `the ticket asks for a refund (${result.answers.refund.noul})`
      )

      t.is(stats.sequences, 3, 'one sequence per question')
      t.ok(stats.forward_passes >= 1, 'at least one forward pass')
      t.ok(
        ['cpu', 'gpu'].includes(stats.backendDevice),
        `backendDevice is named (${stats.backendDevice})`
      )
    })
  }
)

safeTest('a batch answers each state as it would alone', { skip, timeout: 600_000 }, async (t) => {
  await withLaya(t, GPU, async (laya) => {
    const { result: results } = await decide(laya, { states: STATES, questions: QUESTIONS })

    t.is(results.length, STATES.length, 'one result per state')
    for (const [i, state] of STATES.entries()) {
      checkAnswers(t, results[i].answers)
      const { result: alone } = await decide(laya, { state, questions: QUESTIONS })
      t.is(results[i].answers.department.choice, alone.answers.department.choice, `state ${i}`)
    }
  })
})

safeTest('the CPU and the GPU choose the same answers', { skip, timeout: 600_000 }, async (t) => {
  const request = { states: STATES, questions: QUESTIONS }
  const onGpu = await withLaya(t, GPU, async (laya) => (await decide(laya, request)).result)
  const onCpu = await withLaya(t, CPU, async (laya) => (await decide(laya, request)).result)

  for (const [i, result] of onCpu.entries()) {
    t.is(result.answers.department.choice, onGpu[i].answers.department.choice, `state ${i}`)
    t.ok(
      Math.abs(result.answers.refund.noul - onGpu[i].answers.refund.noul) < 0.05,
      `state ${i}: noul ${result.answers.refund.noul} vs ${onGpu[i].answers.refund.noul}`
    )
  }
})

safeTest(
  'an invalid request fails without breaking the instance',
  { skip, timeout: 600_000 },
  async (t) => {
    await withLaya(t, GPU, async (laya) => {
      const bad = { state: STATES[0], questions: { q: { type: 'pick', instructions: 'Which?' } } }
      await t.exception(
        async () => (await laya.run(bad)).await(),
        /unknown type "pick"/,
        'names the unknown question type'
      )

      const { result } = await decide(laya, { state: STATES[0], questions: QUESTIONS })
      checkAnswers(t, result.answers)
    })
  }
)

safeTest('cancel stops a running request', { skip, timeout: 600_000 }, async (t) => {
  await withLaya(t, CPU, async (laya) => {
    // Long enough on any CPU that the cancel lands while it runs.
    const states = Array.from({ length: 512 }, (_, i) => `${STATES[i % STATES.length]} (#${i})`)
    const response = await laya.run({ states, questions: QUESTIONS })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await laya.cancel()
    await t.exception(response.await(), /Job cancelled/)

    const { result } = await decide(laya, { state: STATES[0], questions: QUESTIONS })
    checkAnswers(t, result.answers)
  })
})

safeTest('a second request while one runs is refused', { skip, timeout: 600_000 }, async (t) => {
  await withLaya(t, CPU, async (laya) => {
    const states = Array.from({ length: 64 }, (_, i) => `${STATES[i % STATES.length]} (#${i})`)
    const first = await laya.run({ states, questions: QUESTIONS })
    await t.exception(
      laya.run({ state: STATES[0], questions: QUESTIONS }),
      /a job is already set or being processed/
    )
    const [results] = await first.await()
    t.is(results.length, states.length, 'the first request still completes')
  })
})

safeTest('load rejects a missing device', {}, async (t) => {
  const laya = new LayaDecisions({ files: { model: [NO_MODEL] }, config: {} })
  try {
    await laya.load()
    t.fail('load must reject')
  } catch (err) {
    t.is(err.code, '[ GTE :: InvalidArgument ]', err.message)
  } finally {
    await laya.unload().catch(() => {})
  }
})

safeTest('load rejects an option Laya does not take', {}, async (t) => {
  const laya = new LayaDecisions({
    files: { model: [NO_MODEL] },
    config: { ...GPU, pooling: 'mean' }
  })
  try {
    await laya.load()
    t.fail('load must reject')
  } catch (err) {
    t.is(err.code, '[ GTE :: InvalidConfiguration ]', err.message)
  } finally {
    await laya.unload().catch(() => {})
  }
})

safeTest('load rejects a GGUF that is not a Laya checkpoint', { timeout: 600_000 }, async (t) => {
  const [name, dir] = await ensureModel({ modelName: 'embeddinggemma-300M-Q8_0.gguf' })
  const laya = new LayaDecisions({ files: { model: [path.join(dir, name)] }, config: GPU })
  try {
    await laya.load()
    t.fail('load must reject')
  } catch (err) {
    t.is(err.code, '[ GTE :: UnsupportedModel ]', err.message)
  } finally {
    await laya.unload().catch(() => {})
  }
})

safeTest('run before load is refused', {}, (t) => {
  const laya = new LayaDecisions({ files: { model: [NO_MODEL] }, config: CPU })
  return t.exception(laya.run({ state: STATES[0], questions: QUESTIONS }), /Call load\(\) first/)
})
