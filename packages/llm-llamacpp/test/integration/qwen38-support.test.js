'use strict'

const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const LlmLlamacpp = require('../../index.js')
// safeTest, not brittle's test: a load failure is the *expected* outcome for an
// unsupported architecture, and an unhandled rejection there aborts the whole runner
// (SIGABRT) instead of reporting a result. safeTest turns it into a t.fail.
const { cleanupIntegrationCacheFiles, safeTest } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
// Desktop x64-darwin and linux-arm64 hosts have no working GPU stack here, so they
// drop to CPU; everywhere else uses the backend the addon picks. Same routing as
// qwen3-5.test.js.
const useCpu = isDarwinX64 || isLinuxArm64

// Qwen/Qwen3.8-27B publishes safetensors only, so the GGUF comes from the unsloth
// conversion — the same publisher models.manifest.json already uses for every Qwen3.5
// entry. Pinned to an immutable commit rather than /resolve/main/, per
// MODELS_MANIFEST.md. The repo also carries mmproj-F16.gguf for the vision tower, which
// this probe does not exercise.
const QWEN38_MODEL = {
  name: 'Qwen3.8-27B-Q4_K_M.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/430473d9d0e975450ce1f445642b6527cb4faea1/Qwen3.8-27B-Q4_K_M.gguf',
  // Verified by HEAD against that commit; this is the `bytes` a manifest entry needs.
  // The matching sha256 still has to come from hashing the download, not from a header.
  bytes: 17106773984
}

// Still not in models.manifest.json: resolveModelEntry() there demands a sha256 and a
// byte count, and producing those means hashing ~17 GB first. Until someone runs
// `node scripts/generate-model-manifest.mjs --only Qwen3.8-27B-Q4_K_M.gguf`, ensureModel()
// cannot fetch it and this probe takes a local path instead. Unset, every block skips.
//
//   curl -L -o Qwen3.8-27B-Q4_K_M.gguf <QWEN38_MODEL.url above>
//   QVAC_QWEN38_MODEL_PATH=./Qwen3.8-27B-Q4_K_M.gguf bare test/integration/qwen38-support.test.js
const modelPathEnv = proc.env && proc.env.QVAC_QWEN38_MODEL_PATH
const modelPath = modelPathEnv ? path.resolve(modelPathEnv) : null
const skipReason = modelPath
  ? false
  : `set QVAC_QWEN38_MODEL_PATH to a local copy of ${QWEN38_MODEL.name} — ${QWEN38_MODEL.url}`

// 27B at 4-bit is roughly 17 GB, which will not fit most GPUs. Offloading every layer
// unconditionally would surface as an OOM rather than an answer about whether the
// architecture is supported, so both knobs are overridable without editing this file.
const device = (proc.env && proc.env.QVAC_QWEN38_DEVICE) || (useCpu ? 'cpu' : 'gpu')
const gpuLayers = (proc.env && proc.env.QVAC_QWEN38_GPU_LAYERS) || '999'

// A 27B decodes an order of magnitude slower than the 0.8B this file mirrors.
const TIMEOUT = 1_800_000

// Confirmed against the published chat_template.jinja, which emits '\n<think>\n' and
// '\n</think>\n\n' literally. Kept as constants so a future template revision is a
// one-line edit — a failure confined to these means the markers moved, not that the
// architecture is unsupported.
const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

// Cache files land beside the model, which is guaranteed to exist, and are removed by
// cleanupIntegrationCacheFiles before each run that uses one.
const scratchDir = modelPath ? path.dirname(modelPath) : ''

const BASE_CONFIG = {
  device,
  gpu_layers: gpuLayers,
  ctx_size: '1024',
  n_predict: '256',
  temp: '0',
  seed: '42',
  verbosity: '2'
}

function createLogger() {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

// The template repeats ensureModel() per block only because it needs the download; the
// path is already absolute here, so one builder covers all six.
function buildAddon(configOverrides) {
  return new LlmLlamacpp({
    files: { model: [modelPath] },
    config: { ...BASE_CONFIG, ...configOverrides },
    logger: createLogger(),
    opts: { stats: true }
  })
}

async function collectResponse(response) {
  const chunks = []
  // Bare on arm64 needs a live timer for native-addon microtasks to flush.
  const ticker = setInterval(() => {}, 50)
  try {
    await response
      .onUpdate((data) => {
        chunks.push(data)
      })
      .await()
  } finally {
    clearInterval(ticker)
  }
  return chunks.join('').trim()
}

function parseJsonToolCall(inner) {
  try {
    return JSON.parse(inner)
  } catch (e) {
    return null
  }
}

// Qwen3.8-27B's published chat_template.jinja emits exactly this form — '<tool_call>'
// wrapping '<function=NAME>' and '<parameter=KEY>VALUE</parameter>' — so the XML branch
// is the primary path here and parseJsonToolCall is the fallback, not the reverse.
// Parses HuggingFace function-call XML emitted by Qwen's embedded template:
//   <function=NAME>
//     <parameter=KEY>VALUE</parameter>
//     ...
//   </function>
function parseXmlToolCall(inner) {
  const fnMatch = /<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/.exec(inner)
  if (!fnMatch) return null
  const args = {}
  const paramRegex = /<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g
  let pm
  while ((pm = paramRegex.exec(fnMatch[2])) !== null) {
    args[pm[1].trim()] = pm[2].trim()
  }
  return { name: fnMatch[1].trim(), arguments: args }
}

function extractToolCalls(response) {
  const toolCalls = []
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match
  while ((match = toolCallRegex.exec(response)) !== null) {
    const inner = match[1].trim()
    const parsed = parseJsonToolCall(inner) || parseXmlToolCall(inner)
    if (parsed) toolCalls.push(parsed)
  }
  return toolCalls
}

// Echoing raw output is what separates "architecture unsupported" from "chat template
// differs from the one these assertions were written against".
function reportOutput(t, label, output) {
  t.comment(`${label} (${output.length} chars): ${JSON.stringify(output.slice(0, 300))}`)
}

// Whether the model loads at all is the headline result of this probe, so the reason it
// did not has to survive into the report. Only the first pattern is an answer about
// support; the rest are local problems that say nothing about the architecture.
const LOAD_FAILURE_VERDICTS = [
  [
    /unknown model architecture|unsupported model architecture|unknown architecture/i,
    'ARCHITECTURE UNSUPPORTED — this llama.cpp build does not recognise the model, so the qvac-fabric pin needs a bump'
  ],
  [
    /out of memory|failed to allocate|\boom\b/i,
    'OUT OF MEMORY — lower QVAC_QWEN38_GPU_LAYERS or set QVAC_QWEN38_DEVICE=cpu; says nothing about architecture support'
  ],
  [
    /no such file|cannot open|failed to open/i,
    'MODEL FILE UNREADABLE — check QVAC_QWEN38_MODEL_PATH'
  ]
]

function classifyLoadFailure(message) {
  for (const [pattern, verdict] of LOAD_FAILURE_VERDICTS) {
    if (pattern.test(message)) return verdict
  }
  return 'LOAD FAILED for an unrecognised reason — read the addon log above'
}

async function loadOrExplain(t, addon) {
  try {
    await addon.load()
  } catch (err) {
    const message = String(err && err.message)
    t.comment(`${classifyLoadFailure(message)}\n  underlying error: ${message}`)
    throw err
  }
}

safeTest(
  'Qwen3.8-27B can run basic inference',
  { timeout: TIMEOUT, skip: skipReason },
  async (t) => {
    const addon = buildAddon({})

    try {
      const t0 = Date.now()
      await loadOrExplain(t, addon)
      t.comment(`model.load() took ${Date.now() - t0} ms`)

      // Not exercising reasoning here — keep the model out of the short-budget thinking
      // path so the assertion checks the final answer, not a truncated trace.
      const response = await addon.run(
        [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is 2+2? Answer in one word.' }
        ],
        { generationParams: { reasoning_budget: 0 } }
      )
      const output = await collectResponse(response)
      reportOutput(t, 'output', output)

      t.ok(output.length > 0, `inference produced output (${output.length} chars)`)
      t.ok(
        /4|four/.test(output.toLowerCase()),
        `output contains 4 or four: "${output.slice(0, 100)}"`
      )

      t.ok(response.stats, 'response has stats')
      if (response.stats) {
        t.ok(response.stats.promptTokens > 0, `prompt tokens: ${response.stats.promptTokens}`)
        t.ok(
          response.stats.generatedTokens > 0,
          `generated tokens: ${response.stats.generatedTokens}`
        )
      }
    } finally {
      await addon.unload().catch(() => {})
    }
  }
)

safeTest(
  'Qwen3.8-27B supports multi-turn conversation with KV cache',
  { timeout: TIMEOUT, skip: skipReason },
  async (t) => {
    const addon = buildAddon({ ctx_size: '2048', n_predict: '512' })

    try {
      await loadOrExplain(t, addon)

      const sessionName = path.join(scratchDir, 'qwen38-multiturn-cache.bin')
      cleanupIntegrationCacheFiles(sessionName)

      const systemMsg = {
        role: 'system',
        content: 'You are a helpful assistant. Answer concisely with just the city name.'
      }
      const userTurn1 = { role: 'user', content: 'What is the capital of France?' }

      // Cache control is a runOption (cacheKey), NOT a `{ role: 'session' }` chat
      // message — the latter was removed in v0.15.0 and is silently dropped by Jinja
      // templates with no matching elif branch.
      const noReasoning = { generationParams: { reasoning_budget: 0 } }

      const response1 = await addon.run([systemMsg, userTurn1], {
        cacheKey: sessionName,
        ...noReasoning
      })
      const output1 = await collectResponse(response1)
      reportOutput(t, 'turn 1', output1)

      t.ok(output1.length > 0, `first turn produced output (${output1.length} chars)`)
      t.ok(
        /paris/.test(output1.toLowerCase()),
        `first turn mentions Paris: "${output1.slice(0, 100)}"`
      )
      t.ok(
        response1.stats?.CacheTokens > 0,
        `first turn populated KV cache (CacheTokens=${response1.stats?.CacheTokens})`
      )

      const response2 = await addon.run(
        [
          systemMsg,
          userTurn1,
          { role: 'assistant', content: output1 },
          { role: 'user', content: 'And what about Germany?' }
        ],
        { cacheKey: sessionName, ...noReasoning }
      )
      const output2 = await collectResponse(response2)
      reportOutput(t, 'turn 2', output2)

      t.ok(output2.length > 0, `second turn produced output (${output2.length} chars)`)
      t.ok(
        /berlin/.test(output2.toLowerCase()),
        `second turn mentions Berlin: "${output2.slice(0, 100)}"`
      )
      t.ok(output2 !== output1, 'second turn produced different output from first')
      t.ok(
        response2.stats?.CacheTokens > response1.stats?.CacheTokens,
        `second turn extended the KV cache from turn 1 (${response1.stats?.CacheTokens} -> ${response2.stats?.CacheTokens})`
      )
    } finally {
      await addon.unload().catch(() => {})
    }
  }
)

safeTest('Qwen3.8-27B supports tool calling', { timeout: TIMEOUT, skip: skipReason }, async (t) => {
  const addon = buildAddon({ ctx_size: '4096', n_predict: '512', temp: '0.1', tools: 'true' })

  try {
    await loadOrExplain(t, addon)

    const prompt = [
      { role: 'system', content: 'You are a helpful assistant that uses tools when appropriate.' },
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'Name of the city' },
            unit: {
              type: 'string',
              enum: ['celsius', 'fahrenheit'],
              description: 'Temperature unit'
            }
          },
          required: ['city']
        }
      },
      { role: 'user', content: 'What is the weather in Paris in celsius?' }
    ]

    // Tool-call formatting is the behaviour under test — keep the model out of the
    // short-budget thinking path so the assertion observes final output.
    const response = await addon.run(prompt, { generationParams: { reasoning_budget: 0 } })
    const output = await collectResponse(response)
    reportOutput(t, 'tool-calling output', output)

    t.ok(output.length > 0, `tool calling produced output (${output.length} chars)`)

    const toolCalls = extractToolCalls(output)
    t.ok(toolCalls.length > 0, `extracted at least one tool call (got ${toolCalls.length})`)

    const weatherCall = toolCalls.find((tc) => tc.name === 'get_weather')
    t.ok(weatherCall, 'model called get_weather tool')
    t.ok(weatherCall?.arguments, 'tool call has arguments')
    const city = weatherCall?.arguments?.city?.toLowerCase() || ''
    t.ok(/paris/.test(city), `tool call city argument mentions Paris: "${city}"`)
  } finally {
    await addon.unload().catch(() => {})
  }
})

safeTest(
  'Qwen3.8-27B reasoning-budget=0 disables thinking',
  { timeout: TIMEOUT, skip: skipReason },
  async (t) => {
    // Thinking traces can run past 1k tokens before closing, so the budget has to be
    // large enough that the closing marker is not cut off or the baseline fails.
    const baseConfig = { ctx_size: '4096', n_predict: '3072', verbosity: '0' }

    async function runOnce(extra) {
      const addon = buildAddon({ ...baseConfig, ...extra })
      try {
        await loadOrExplain(t, addon)
        const response = await addon.run([
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is the capital of France? Answer in one word.' }
        ])
        return await collectResponse(response)
      } finally {
        await addon.unload().catch(() => {})
      }
    }

    const baseline = await runOnce({})
    const disabled = await runOnce({ 'reasoning-budget': '0' })
    const disabledUnderscore = await runOnce({ reasoning_budget: '0' })

    reportOutput(t, 'baseline', baseline)
    reportOutput(t, 'disabled', disabled)

    t.ok(/paris/i.test(baseline), `baseline mentions Paris: "${baseline.slice(0, 80)}"`)
    t.ok(/paris/i.test(disabled), `disabled mentions Paris: "${disabled.slice(0, 80)}"`)
    t.ok(/paris/i.test(disabledUnderscore), 'underscore variant also accepted and mentions Paris')

    t.ok(
      baseline.includes(THINK_OPEN),
      `baseline should contain ${THINK_OPEN}: "${baseline.slice(0, 100)}"`
    )
    if (isLinuxArm64) {
      // CPU greedy decode on ARM64 routinely exhausts n_predict mid-thought, and a 27B
      // makes that likelier still. Only assert clean closure when it actually closed.
      if (baseline.includes(THINK_CLOSE)) {
        t.ok(
          baseline.indexOf(THINK_OPEN) < baseline.indexOf(THINK_CLOSE),
          'baseline opening marker must precede closing marker'
        )
      } else {
        t.comment(
          `baseline opened ${THINK_OPEN} but did not close it within n_predict (${baseline.length} chars) — skipping closing-marker assertion`
        )
      }
    } else {
      t.ok(
        baseline.includes(THINK_CLOSE),
        `baseline should contain ${THINK_CLOSE}: "${baseline.slice(-100)}"`
      )
      t.ok(
        baseline.indexOf(THINK_OPEN) < baseline.indexOf(THINK_CLOSE),
        'baseline opening marker must precede closing marker'
      )
    }

    t.absent(
      /Thinking Process/i.test(disabled),
      `disabled output should not contain "Thinking Process": "${disabled.slice(0, 200)}"`
    )
    t.absent(
      disabled.includes(THINK_OPEN),
      `disabled output should not contain ${THINK_OPEN}: "${disabled.slice(0, 200)}"`
    )
    t.absent(
      disabled.includes(THINK_CLOSE),
      `disabled output should not contain ${THINK_CLOSE}: "${disabled.slice(0, 200)}"`
    )
    t.ok(
      disabled.length < baseline.length / 4,
      `disabled (${disabled.length}) should be substantially shorter than baseline (${baseline.length})`
    )
  }
)

safeTest(
  'Qwen3.8-27B n_predict exhaustion mid-reasoning does not abort',
  { timeout: TIMEOUT, skip: skipReason },
  async (t) => {
    const addon = buildAddon({ ctx_size: '2048', n_predict: '64' })

    try {
      await loadOrExplain(t, addon)

      const sessionName = path.join(scratchDir, 'qwen38-npredict-mid-reasoning-cache.bin')
      cleanupIntegrationCacheFiles(sessionName)

      const systemMsg = {
        role: 'system',
        content: 'You are a helpful assistant. Answer concisely with just the city name.'
      }
      const userTurn1 = { role: 'user', content: 'What is the capital of France?' }
      const noReasoning = { generationParams: { reasoning_budget: 0 } }

      const primerResponse = await addon.run([systemMsg, userTurn1], {
        cacheKey: sessionName,
        ...noReasoning
      })
      const primerOutput = await collectResponse(primerResponse)
      t.ok(/paris/i.test(primerOutput), `primer mentions Paris: "${primerOutput.slice(0, 100)}"`)
      t.ok(
        primerResponse.stats?.CacheTokens > 0,
        `primer populated cache (CacheTokens=${primerResponse.stats?.CacheTokens})`
      )

      const response = await addon.run(
        [
          systemMsg,
          userTurn1,
          { role: 'assistant', content: primerOutput },
          {
            role: 'user',
            content:
              'Before answering, reason in detail for at least 20 sentences, then answer: What is the capital of France?'
          }
        ],
        { cacheKey: sessionName, generationParams: { remove_thinking_from_context: true } }
      )
      const output = await collectResponse(response)

      reportOutput(t, 'small-budget output', output)
      t.comment(`small-budget stats: ${JSON.stringify(response.stats || {})}`)

      t.ok(output.length > 0, `small-budget run produced output (${output.length} chars)`)
      t.ok(
        output.includes(THINK_OPEN),
        `small-budget run should enter reasoning before the n_predict cutoff: "${output.slice(0, 120)}"`
      )
      t.absent(
        output.includes(THINK_CLOSE),
        `small-budget run should be cut off before closing reasoning: "${output.slice(-120)}"`
      )
      t.ok(
        response.stats?.generatedTokens >= 64,
        `small-budget run should reach n_predict (generatedTokens=${response.stats?.generatedTokens})`
      )
      t.is(
        response.stats?.CacheTokens,
        primerResponse.stats?.CacheTokens,
        `small-budget run should roll cache back to primer state (${primerResponse.stats?.CacheTokens})`
      )

      const followUpResponse = await addon.run(
        [
          systemMsg,
          userTurn1,
          { role: 'assistant', content: primerOutput },
          { role: 'user', content: 'And what about Germany?' }
        ],
        { cacheKey: sessionName, ...noReasoning }
      )
      const followUpOutput = await collectResponse(followUpResponse)
      t.ok(
        /berlin/i.test(followUpOutput),
        `follow-up after rollback should still answer from clean cache: "${followUpOutput.slice(0, 100)}"`
      )
      t.ok(
        followUpResponse.stats?.CacheTokens > primerResponse.stats?.CacheTokens,
        `follow-up should extend primer cache (${primerResponse.stats?.CacheTokens} -> ${followUpResponse.stats?.CacheTokens})`
      )
    } finally {
      await addon.unload().catch(() => {})
    }
  }
)

safeTest(
  'Qwen3.8-27B per-request generationParams.reasoning_budget overrides load-time default',
  { timeout: TIMEOUT, skip: skipReason },
  async (t) => {
    const addon = buildAddon({ ctx_size: '4096', n_predict: '3072', verbosity: '0' })

    try {
      await loadOrExplain(t, addon)

      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the capital of France? Answer in one word.' }
      ]

      const overrideResponse = await addon.run(messages, {
        generationParams: { reasoning_budget: 0 }
      })
      const overrideOutput = await collectResponse(overrideResponse)

      const defaultResponse = await addon.run(messages)
      const defaultOutput = await collectResponse(defaultResponse)

      reportOutput(t, 'override', overrideOutput)
      reportOutput(t, 'default', defaultOutput)

      t.absent(
        overrideOutput.includes(THINK_OPEN),
        `per-request override should suppress ${THINK_OPEN}: "${overrideOutput.slice(0, 200)}"`
      )
      t.absent(
        overrideOutput.includes(THINK_CLOSE),
        `per-request override should suppress ${THINK_CLOSE}: "${overrideOutput.slice(0, 200)}"`
      )

      t.ok(
        defaultOutput.includes(THINK_OPEN),
        `subsequent default run should restore ${THINK_OPEN}: "${defaultOutput.slice(0, 200)}"`
      )
      if (isLinuxArm64) {
        // CPU greedy on ARM64 may exhaust n_predict before closing; accept that as a
        // valid restore so long as the opening marker reappeared.
        if (defaultOutput.includes(THINK_CLOSE)) {
          t.ok(
            defaultOutput.indexOf(THINK_OPEN) < defaultOutput.indexOf(THINK_CLOSE),
            'subsequent default opening marker must precede closing marker'
          )
        } else {
          t.comment(
            `subsequent default run opened ${THINK_OPEN} but did not close it within n_predict (${defaultOutput.length} chars) — skipping closing-marker assertion`
          )
        }
      } else {
        t.ok(
          defaultOutput.includes(THINK_CLOSE),
          `subsequent default run should restore ${THINK_CLOSE}: "${defaultOutput.slice(-200)}"`
        )
        t.ok(
          defaultOutput.indexOf(THINK_OPEN) < defaultOutput.indexOf(THINK_CLOSE),
          'subsequent default opening marker must precede closing marker'
        )
      }
    } finally {
      await addon.unload().catch(() => {})
    }
  }
)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
