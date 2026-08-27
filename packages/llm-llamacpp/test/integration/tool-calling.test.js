'use strict'

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const { recordPerformance } = require('./_perf-helper.js')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'

// QVAC-17830: also honour NO_GPU=true so CPU-only matrix legs label
// their perf rows as [CPU] in the report. Same NO_GPU detection
// pattern as _image-common.js.
// Bare doesn't define `process` as a global at module-init time, so
// the fallback to `process.env` is guarded with `typeof process`.
const noGpuEnv =
  (typeof os.getEnv === 'function' ? os.getEnv('NO_GPU') : '') ||
  (typeof process !== 'undefined' && process.env ? process.env.NO_GPU : '')
const noGpu = String(noGpuEnv || '').toLowerCase() === 'true'
const useCpu = isLinuxArm64 || noGpu

const TOOL_MODEL_VARIANTS = [
  {
    id: 'qwen3-1.7b',
    modelName: 'Qwen3-1.7B-Q4_0.gguf',
    downloadUrl: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_0.gguf'
  }
]

const BASE_CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '999',
  ctx_size: '8192',
  temp: '0.1',
  n_predict: '1024',
  verbosity: '2',
  tools: 'true'
}

const prompt1Base = [
  { role: 'system', content: 'You are a helpful assistant.' },
  {
    type: 'function',
    name: 'searchProducts',
    description: 'Search products',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query' },
        category: {
          type: 'string',
          enum: ['electronics', 'clothing', 'books'],
          description: 'Category'
        },
        maxPrice: { type: 'number', minimum: 0, description: 'Max price' }
      },
      required: ['query']
    }
  },
  {
    type: 'function',
    name: 'addToCart',
    description: 'Add items to cart',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: { type: 'string', description: 'Product ID' },
              quantity: { type: 'integer', minimum: 1, description: 'Quantity' }
            },
            required: ['productId', 'quantity']
          }
        }
      },
      required: ['items']
    }
  },
  {
    type: 'function',
    name: 'queryDB',
    description: 'Query database',
    parameters: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table' },
        conditions: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'Field' },
            operator: { type: 'string', enum: ['equals', 'greaterThan'], description: 'Operator' },
            value: { type: 'string', description: 'Value' }
          },
          required: ['field', 'operator', 'value']
        },
        limit: { type: 'integer', minimum: 1, default: 10, description: 'Limit' },
        includeMetadata: { type: 'boolean', default: false, description: 'Include metadata' }
      },
      required: ['table', 'conditions']
    }
  },
  {
    role: 'user',
    content:
      'Search laptops under $1000 and add 2 with ID "laptop-123" to cart. Also, query users table age > 25 limit 50 with metadata.'
  }
]

function clonePrompt() {
  return JSON.parse(JSON.stringify(prompt1Base))
}

function buildPrompt2(assistantOutput) {
  const prompt = clonePrompt()
  prompt.push({ role: 'assistant', content: assistantOutput })
  prompt.push({ role: 'user', content: 'Search for TVs under $2000' })
  return prompt
}

function parseToolCalls(output, t) {
  const toolCalls = []
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match

  while ((match = toolCallRegex.exec(output)) !== null) {
    const raw = match[1].trim()
    try {
      toolCalls.push(JSON.parse(raw))
    } catch (err) {
      t.fail(`tool_call block contains malformed JSON: ${err.message}\n  raw: ${raw.slice(0, 200)}`)
    }
  }

  return toolCalls
}

function assertDeclaredToolCalls(t, output, prompt, label) {
  const declaredTools = new Map(
    prompt.filter((item) => item.type === 'function').map((tool) => [tool.name, tool])
  )
  const toolCalls = parseToolCalls(output, t)

  t.ok(toolCalls.length > 0, `${label}: output contains at least one valid tool_call block`)

  for (const toolCall of toolCalls) {
    const tool = declaredTools.get(toolCall.name)
    t.ok(tool, `${label}: tool_call name "${toolCall.name}" is declared`)
    if (!tool) continue

    t.ok(
      toolCall.arguments && typeof toolCall.arguments === 'object',
      `${label}: tool_call "${toolCall.name}" has arguments`
    )
    if (!toolCall.arguments || typeof toolCall.arguments !== 'object') continue

    for (const required of tool.parameters.required || []) {
      t.ok(
        required in toolCall.arguments,
        `${label}: tool_call "${toolCall.name}" has required argument "${required}"`
      )
    }

    assertArgumentsMatchSchema(
      t,
      toolCall.arguments,
      tool.parameters,
      `${label}: "${toolCall.name}"`
    )
  }
}

// Under the template's tool grammar a schema-invalid argument is
// unrepresentable, so every argument the model emitted must satisfy the
// declared JSON-schema type and enum. `minimum`/`default` are deliberately
// not checked: they are not grammar properties.
function assertArgumentsMatchSchema(t, args, schema, label) {
  const properties = (schema && schema.properties) || {}
  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key]
    t.ok(prop, `${label}: argument "${key}" is declared in the schema`)
    if (!prop) continue
    assertValueMatchesSchema(t, value, prop, `${label}.${key}`)
  }
}

function assertValueMatchesSchema(t, value, prop, label) {
  if (prop.enum) {
    t.ok(prop.enum.includes(value), `${label}: value ${JSON.stringify(value)} is in enum`)
    return
  }
  switch (prop.type) {
    case 'integer':
      t.ok(Number.isInteger(value), `${label}: ${JSON.stringify(value)} is an integer`)
      break
    case 'number':
      t.ok(typeof value === 'number', `${label}: ${JSON.stringify(value)} is a number`)
      break
    case 'string':
      t.ok(typeof value === 'string', `${label}: ${JSON.stringify(value)} is a string`)
      break
    case 'boolean':
      t.ok(typeof value === 'boolean', `${label}: ${JSON.stringify(value)} is a boolean`)
      break
    case 'array':
      t.ok(Array.isArray(value), `${label}: is an array`)
      if (Array.isArray(value) && prop.items) {
        value.forEach((item, i) => assertValueMatchesSchema(t, item, prop.items, `${label}[${i}]`))
      }
      break
    case 'object':
      t.ok(value && typeof value === 'object' && !Array.isArray(value), `${label}: is an object`)
      if (value && typeof value === 'object') assertArgumentsMatchSchema(t, value, prop, label)
      break
    default:
      break
  }
}

async function collectResponse(response) {
  const chunks = []
  await response
    .onUpdate((data) => {
      chunks.push(data)
    })
    .await()

  const stats = response.stats || {}
  return {
    text: chunks.join('').trim(),
    generatedTokens: Number(stats.generatedTokens || 0),
    stats
  }
}

async function createToolModel(modelVariant) {
  const [modelName, dirPath] = await ensureModel({
    modelName: modelVariant.modelName,
    downloadUrl: modelVariant.downloadUrl
  })

  const modelPath = path.join(dirPath, modelName)
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  let loggerReleased = false
  const releaseLogger = () => {
    if (loggerReleased) return
    loggerReleased = true
    specLogger.release()
  }

  const model = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: BASE_CONFIG,
    logger: console,
    opts: { stats: true }
  })

  try {
    await model.load()
  } catch (err) {
    releaseLogger()
    throw err
  }

  return {
    model,
    async release() {
      await model.unload().catch(() => {})
      releaseLogger()
    }
  }
}

async function runPrompt(model, prompt) {
  const startTime = Date.now()
  const response = await model.run(prompt)
  const collected = await collectResponse(response)
  return {
    ...collected,
    startTime,
    endTime: Date.now()
  }
}

const epTag = useCpu ? 'CPU' : 'GPU'
const deviceId = useCpu ? 'cpu' : 'gpu'

safeTest('[tools] prompt scenarios', { timeout: 1_800_000, skip: isDarwinX64 }, async (t) => {
  for (const modelVariant of TOOL_MODEL_VARIANTS) {
    let release = null
    try {
      const result = await createToolModel(modelVariant)
      release = result.release
      const model = result.model
      const label = `[${modelVariant.id}]`

      // QVAC-17830: record one perf row per (model_variant x prompt)
      // cell, scenario='tool-calling'. prompt1 is the cold inference
      // (KV cache empty, function-spec prefill heavy); prompt2 reuses
      // the loaded model so its TTFT/TPS reflect a warm follow-up
      // call. Keeping both rows in the report shows the cold-vs-warm
      // delta for the same model on the same device.
      const firstPrompt = clonePrompt()
      const firstRun = await runPrompt(model, firstPrompt)
      t.ok(firstRun.text.length > 0, `${label} prompt1: generated text`)
      t.ok(firstRun.generatedTokens > 0, `${label} prompt1: generated tokens tracked`)
      assertDeclaredToolCalls(t, firstRun.text, firstPrompt, `${label} prompt1`)
      const perfLabel1 = `[tools batch] [${modelVariant.id}] [${epTag}]`
      t.comment(
        recordPerformance(perfLabel1, firstRun.endTime - firstRun.startTime, {
          _output: firstRun.text,
          stats: firstRun.stats,
          deviceId,
          scenario: 'tool-calling',
          model: modelVariant.modelName.replace(/\.gguf$/i, '')
        })
      )

      const secondPrompt = buildPrompt2(firstRun.text)
      const secondRun = await runPrompt(model, secondPrompt)
      t.ok(secondRun.text.length > 0, `${label} prompt2: generated text`)
      t.ok(secondRun.generatedTokens > 0, `${label} prompt2: generated tokens tracked`)
      assertDeclaredToolCalls(t, secondRun.text, secondPrompt, `${label} prompt2`)
      const perfLabel2 = `[tools followup] [${modelVariant.id}] [${epTag}]`
      t.comment(
        recordPerformance(perfLabel2, secondRun.endTime - secondRun.startTime, {
          _output: secondRun.text,
          stats: secondRun.stats,
          deviceId,
          scenario: 'tool-calling',
          model: modelVariant.modelName.replace(/\.gguf$/i, '')
        })
      )
    } finally {
      if (release) await release()
    }
  }
})

// The tool grammar applied for a tools request must not survive into the
// next request on the same loaded model: a plain question must answer in
// text, not in a <tool_call> block.
safeTest(
  '[tools] grammar does not leak into a tools-free follow-up',
  { timeout: 1_800_000, skip: isDarwinX64 },
  async (t) => {
    const modelVariant = TOOL_MODEL_VARIANTS[0]
    const { model, release } = await createToolModel(modelVariant)
    try {
      const withTools = await runPrompt(model, clonePrompt())
      t.ok(withTools.text.length > 0, 'tools prompt generated text')

      const plainPrompt = [
        { role: 'system', content: 'You are a helpful assistant. /no_think' },
        { role: 'user', content: 'Name one colour of the rainbow.' }
      ]
      const withoutTools = await runPrompt(model, plainPrompt)
      t.ok(withoutTools.text.length > 0, 'tools-free prompt generated text')
      t.absent(
        withoutTools.text.includes('<tool_call>'),
        `tools-free output has no tool_call block: ${withoutTools.text.slice(0, 200)}`
      )
    } finally {
      await release()
    }
  }
)

// generationParams.tool_choice: "required" forces a call, "none" turns the
// tool grammar off (tools stay in the prompt), a function name restricts the
// call to that function, and an undeclared name is rejected up front.
safeTest(
  '[tools] tool_choice controls whether and which tool is called',
  { timeout: 1_800_000, skip: isDarwinX64 },
  async (t) => {
    const modelVariant = TOOL_MODEL_VARIANTS[0]
    const { model, release } = await createToolModel(modelVariant)
    try {
      async function runWithToolChoice(toolChoice) {
        const response = await model.run(clonePrompt(), {
          generationParams: { tool_choice: toolChoice }
        })
        return (await collectResponse(response)).text
      }

      const required = await runWithToolChoice('required')
      t.ok(
        required.includes('<tool_call>'),
        `required produced a tool call: ${required.slice(0, 200)}`
      )
      assertDeclaredToolCalls(t, required, clonePrompt(), 'required')

      const named = await runWithToolChoice('queryDB')
      const namedCalls = parseToolCalls(named, t)
      t.ok(namedCalls.length > 0, 'named function produced a tool call')
      for (const call of namedCalls) {
        t.is(call.name, 'queryDB', 'named function restricts the call to that function')
      }

      // "none" only removes the grammar constraint (llama-server semantics);
      // the tools stay in the prompt, so a call is still allowed, just not
      // enforced. The contract under test is that the request completes.
      const none = await runWithToolChoice('none')
      t.ok(none.length > 0, `none still generated text: ${none.slice(0, 200)}`)

      // `t.exception.all` so a native error subclass cannot escape as an
      // unhandled rejection (see grammar.test.js for the rationale).
      // The addon raises during the job, so the rejection surfaces on the
      // response's `.await()`, not on `model.run()` itself.
      await t.exception.all(
        async () => {
          const response = await model.run(clonePrompt(), {
            generationParams: { tool_choice: 'notDeclared' }
          })
          await response.await()
        },
        /undeclared function/,
        'an undeclared function name is rejected'
      )
    } finally {
      await release()
    }
  }
)

// A per-request GBNF grammar takes precedence over the template's tool
// grammar; the request must complete and honour the user's grammar.
safeTest(
  '[tools] per-request grammar wins over the tool grammar',
  { timeout: 1_800_000, skip: isDarwinX64 },
  async (t) => {
    const modelVariant = TOOL_MODEL_VARIANTS[0]
    const { model, release } = await createToolModel(modelVariant)
    try {
      const prompt = clonePrompt()
      prompt[prompt.length - 1] = {
        role: 'user',
        content: 'Answer only yes or no: is the sky blue? /no_think'
      }
      const response = await model.run(prompt, {
        generationParams: { grammar: 'root ::= ("yes" | "no")', predict: 4, seed: 42 }
      })
      const { text } = await collectResponse(response)
      t.ok(text === 'yes' || text === 'no', `user grammar constrained the output (got "${text}")`)
    } finally {
      await release()
    }
  }
)
