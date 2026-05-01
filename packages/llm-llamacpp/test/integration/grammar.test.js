'use strict'

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const PROMPT = [
  { role: 'system', content: 'You are a binary classifier. Reply only "yes" or "no". /no_think' },
  { role: 'user', content: 'Is the sky blue on a clear day?' }
]

async function setupModel (t, configOverrides = {}) {
  const [modelName, dirPath] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })

  const modelPath = path.join(dirPath, modelName)
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '1024',
    n_predict: '64',
    temp: '1.0',
    verbosity: '2',
    ...configOverrides
  }

  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })

  await model.load()

  t.teardown(async () => {
    await model.unload().catch(() => {})
    specLogger.release()
  })

  return { model }
}

async function collectResponse (response) {
  const chunks = []
  await response.onUpdate(data => { chunks.push(data) }).await()
  return chunks.join('')
}

test('generationParams | grammar constrains output to GBNF', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { seed: '42' })

  const grammar = 'root ::= ("yes" | "no")'

  const response = await model.run(PROMPT, {
    generationParams: { grammar, predict: 4, seed: 42 }
  })
  const output = (await collectResponse(response)).trim()

  t.ok(
    output === 'yes' || output === 'no',
    `output "${output}" is constrained to "yes" or "no"`
  )
})

test('generationParams | grammar is per-request, restored after run', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { seed: '42' })

  const grammar = 'root ::= ("yes" | "no")'

  const constrained = await model.run(PROMPT, {
    generationParams: { grammar, predict: 4, seed: 42 }
  })
  const constrainedOutput = (await collectResponse(constrained)).trim()
  t.ok(
    constrainedOutput === 'yes' || constrainedOutput === 'no',
    `constrained output "${constrainedOutput}" respects grammar`
  )

  const unconstrained = await model.run(
    [
      { role: 'system', content: 'You are a helpful assistant. /no_think' },
      { role: 'user', content: 'List three random animals.' }
    ],
    { generationParams: { predict: 48, seed: 42 } }
  )
  const unconstrainedOutput = await collectResponse(unconstrained)

  t.ok(
    unconstrainedOutput.length > constrainedOutput.length,
    `unconstrained output (${unconstrainedOutput.length} chars) exceeds constrained (${constrainedOutput.length} chars)`
  )
  t.ok(
    !(unconstrainedOutput.trim() === 'yes' || unconstrainedOutput.trim() === 'no'),
    'second run is not constrained by the previous request grammar'
  )
})

test('generationParams | grammar overrides load-time grammar', { timeout: 600_000 }, async t => {
  const loadTimeGrammar = 'root ::= "loaded"'
  const { model } = await setupModel(t, {
    seed: '42',
    grammar: loadTimeGrammar
  })

  const requestGrammar = 'root ::= ("yes" | "no")'
  const response = await model.run(PROMPT, {
    generationParams: { grammar: requestGrammar, predict: 4, seed: 42 }
  })
  const output = (await collectResponse(response)).trim()

  t.ok(
    output === 'yes' || output === 'no',
    `per-request grammar wins over load-time grammar (got "${output}")`
  )
})

const PERSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' }
  },
  required: ['name', 'age'],
  additionalProperties: false
}

const PERSON_PROMPT = [
  { role: 'system', content: 'Extract the person info as JSON. /no_think' },
  { role: 'user', content: "Hi, I'm Alice and I'm 30 years old." }
]

test('generationParams | json_schema (object) constrains output to schema-valid JSON', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { seed: '42' })

  const response = await model.run(PERSON_PROMPT, {
    generationParams: { json_schema: PERSON_SCHEMA, predict: 64, seed: 42 }
  })
  const output = (await collectResponse(response)).trim()

  let parsed
  t.execution(() => { parsed = JSON.parse(output) }, `output "${output}" parses as JSON`)
  t.ok(parsed && typeof parsed.name === 'string', `name is a string (got ${JSON.stringify(parsed?.name)})`)
  t.ok(parsed && Number.isInteger(parsed.age), `age is an integer (got ${JSON.stringify(parsed?.age)})`)
  t.is(Object.keys(parsed || {}).sort().join(','), 'age,name', 'no extra properties beyond schema')
})

test('generationParams | json_schema (string) is accepted', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { seed: '42' })

  const response = await model.run(PERSON_PROMPT, {
    generationParams: {
      json_schema: JSON.stringify(PERSON_SCHEMA),
      predict: 64,
      seed: 42
    }
  })
  const output = (await collectResponse(response)).trim()

  let parsed
  t.execution(() => { parsed = JSON.parse(output) }, `output "${output}" parses as JSON`)
  t.ok(parsed && typeof parsed.name === 'string' && Number.isInteger(parsed.age), 'matches schema shape')
})

test('generationParams | grammar + json_schema together throws', { timeout: 600_000 }, async t => {
  const { model } = await setupModel(t, { seed: '42' })

  // `normalizeGenerationParams` throws a `TypeError` for the mutually
  // exclusive case, and brittle's plain `t.exception` deliberately
  // re-raises native error subclasses (TypeError / RangeError / etc.)
  // — the rejection bypasses the catch and trips Bare's
  // unhandled-rejection guard, aborting with exit 134. `t.exception.all`
  // is the documented escape hatch for native-error rejections.
  await t.exception.all(
    () => model.run(PERSON_PROMPT, {
      generationParams: {
        grammar: 'root ::= "x"',
        json_schema: PERSON_SCHEMA,
        predict: 4
      }
    }),
    /mutually exclusive/i,
    'rejects requests that set both grammar and json_schema'
  )
})
