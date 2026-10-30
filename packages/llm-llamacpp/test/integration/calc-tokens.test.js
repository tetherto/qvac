'use strict'

// LlmLlamacpp.calcTokens(): token counts without running the model, checked
// against the promptTokens a fresh run() reports for the same input.

const path = require('bare-path')
const os = require('bare-os')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

// Smallest model with fast load, same as api-behavior.test.js
const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

const SYSTEM = { role: 'system', content: 'You are a helpful assistant.' }
const USER = { role: 'user', content: 'Weather in Paris?' }
const WEATHER_TOOL = {
  type: 'function',
  name: 'get_weather',
  description: 'Get the weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city']
  }
}

const toNumber = (value) => (typeof value === 'number' ? value : Number(value || 0))

async function modelPath() {
  const [modelName, dirPath] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })
  return path.join(dirPath, modelName)
}

function createModel(file, configOverrides = {}) {
  return new LlmLlamacpp({
    files: { model: [file] },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '999',
      ctx_size: '2048',
      n_predict: '8',
      // Renders tool definitions through the model's jinja template, as run() does.
      tools: 'true',
      verbosity: '2',
      ...configOverrides
    },
    logger: console,
    opts: { stats: true }
  })
}

async function setupModel(t, configOverrides = {}) {
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const model = createModel(await modelPath(), configOverrides)
  await model.load()
  t.teardown(async () => {
    await model.unload().catch(() => {})
    specLogger.release()
  })
  return model
}

async function promptTokensOfRun(model, prompt) {
  const response = await model.run(prompt)
  await response.onUpdate(() => {}).await()
  return toNumber(response.stats?.promptTokens)
}

// The error `fn` rejects with, or null when it resolves.
async function rejection(fn) {
  try {
    await fn()
    return null
  } catch (err) {
    return err
  }
}

async function expectTypeError(t, fn, pattern, label) {
  const err = await rejection(fn)
  t.ok(
    err instanceof TypeError && pattern.test(err.message),
    `${label}: rejects with a TypeError (${err?.message})`
  )
}

async function expectInvalidArgument(t, fn, label) {
  const err = await rejection(fn)
  t.ok(
    err !== null && /InvalidArgument/.test(String(err.code)) && /^calcTokens: /.test(err.message),
    `${label}: rejects with InvalidArgument (${err?.code}: ${err?.message})`
  )
}

safeTest('calcTokens | text alone is counted raw', { timeout: 600_000 }, async (t) => {
  const model = await setupModel(t)

  const hello = await model.calcTokens({ text: 'Hello' })
  const longer = await model.calcTokens({ text: 'Hello, world! How are you today?' })
  t.ok(Number.isInteger(hello) && hello > 0, `a word takes tokens (${hello})`)
  t.ok(longer > hello, `a longer text takes more tokens (${longer} > ${hello})`)
  t.is(await model.calcTokens({ text: '' }), 0, 'an empty text takes no tokens')
  t.is(
    await model.calcTokens({ text: 'Hello', history: null, tools: null }),
    hello,
    'null fields count as not passed'
  )
  t.ok(
    (await model.calcTokens({ text: 'Hello', history: [] })) > hello,
    'with a history the text is wrapped by the chat template'
  )
})

safeTest(
  'calcTokens | history matches the promptTokens of a fresh run',
  { timeout: 600_000 },
  async (t) => {
    const model = await setupModel(t)

    const fromHistory = await model.calcTokens({ history: [SYSTEM, USER] })
    const fromText = await model.calcTokens({ text: USER.content, history: [SYSTEM] })
    t.is(fromText, fromHistory, 'text is appended to the history as the last user turn')

    const promptTokens = await promptTokensOfRun(model, [SYSTEM, USER])
    t.comment(`calcTokens=${fromHistory} promptTokens=${promptTokens}`)
    t.is(fromHistory, promptTokens, 'the count is what run() decodes for the same prompt')
  }
)

safeTest(
  'calcTokens | tools match the promptTokens of a fresh run',
  { timeout: 600_000 },
  async (t) => {
    const model = await setupModel(t)

    const withoutTools = await model.calcTokens({ history: [SYSTEM, USER] })
    const withTools = await model.calcTokens({ history: [SYSTEM, USER], tools: [WEATHER_TOOL] })
    t.ok(withTools > withoutTools, `tools add tokens (${withTools} > ${withoutTools})`)
    t.is(
      await model.calcTokens({ history: [SYSTEM, WEATHER_TOOL, USER] }),
      withTools,
      'a tool in the history counts the same as one in tools'
    )

    const promptTokens = await promptTokensOfRun(model, [SYSTEM, WEATHER_TOOL, USER])
    t.comment(`calcTokens=${withTools} promptTokens=${promptTokens}`)
    t.is(withTools, promptTokens, 'the count is what run() decodes for the same prompt')
  }
)

safeTest('calcTokens | answers while a run is generating', { timeout: 600_000 }, async (t) => {
  const model = await setupModel(t, { n_predict: '512' })
  const prompt = [SYSTEM, { role: 'user', content: 'Tell me a long story about a dragon.' }]
  const expected = await model.calcTokens({ history: prompt })

  const response = await model.run(prompt)
  let done = false
  let chunks = 0
  let firstChunk
  const started = new Promise((resolve) => {
    firstChunk = resolve
  })
  response.onUpdate(() => {
    chunks++
    firstChunk()
  })
  const finished = response.await().then(
    () => {
      done = true
    },
    () => {
      done = true
    }
  )

  // A run that fails or ends without output settles `finished` instead.
  await Promise.race([started, finished])
  t.ok(chunks > 0 && !done, `the run is generating (chunks=${chunks}, done=${done})`)
  const during = await model.calcTokens({ history: prompt })
  t.absent(done, 'the count came back before the run finished')
  t.is(during, expected, 'the count does not change while a run decodes')

  await response.cancel()
  await finished
})

safeTest('calcTokens | rejects invalid input', { timeout: 600_000 }, async (t) => {
  const file = await modelPath()

  const unloaded = createModel(file)
  await t.exception.all(
    () => unloaded.calcTokens({ text: 'Hi' }),
    /Model is not loaded/,
    'rejects before load()'
  )

  const model = await setupModel(t)
  await expectTypeError(t, () => model.calcTokens(null), /requires an object/, 'non-object input')
  await expectTypeError(
    t,
    () => model.calcTokens({ text: 1 }),
    /text must be a string/,
    'non-string text'
  )
  await expectTypeError(
    t,
    () => model.calcTokens({ history: '[]' }),
    /history must be a Message\[\]/,
    'history as JSON text'
  )
  await expectTypeError(
    t,
    () => model.calcTokens({ text: 'Hi', tools: WEATHER_TOOL }),
    /tools must be an array/,
    'tools not in an array'
  )

  await expectInvalidArgument(t, () => model.calcTokens({}), 'nothing to count')
  await expectInvalidArgument(
    t,
    () => model.calcTokens({ tools: [WEATHER_TOOL] }),
    'tools with no message to render'
  )
  await expectInvalidArgument(t, () => model.calcTokens({ history: [] }), 'an empty conversation')
  await expectInvalidArgument(
    t,
    () => model.calcTokens({ text: 'Hi', tools: [USER] }),
    'a message among the tool definitions'
  )
  await expectInvalidArgument(
    t,
    () => model.calcTokens({ text: 'Hi', history: [WEATHER_TOOL], tools: [WEATHER_TOOL] }),
    'the same tool in history and tools'
  )
  await expectInvalidArgument(
    t,
    () =>
      model.calcTokens({
        history: [{ role: 'user', type: 'media', content: new Uint8Array([1, 2, 3]) }]
      }),
    'a media message'
  )
  t.ok(
    (await model.calcTokens({ text: 'Hi' })) > 0,
    'the model still counts after rejected requests'
  )

  await model.unload()
  await t.exception.all(
    () => model.calcTokens({ text: 'Hi' }),
    /Model is not loaded/,
    'rejects after unload()'
  )
})
