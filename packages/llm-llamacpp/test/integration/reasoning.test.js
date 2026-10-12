'use strict'

const path = require('bare-path')
const { cleanupIntegrationCacheFiles, ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const overflow = require('./_context-overflow')
const os = require('bare-os')
const LlmLlamacpp = require('../../index.js')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const isWindowsX64 = os.platform() === 'win32' && os.arch() === 'x64'
const useCpu = isLinuxArm64

const MODEL = {
  name: 'Qwen3-0.6B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf'
}

// Qwen3.5 is a separate family checkpoint: the PR widened reasoning detection
// from exact-match `qwen3` to a `qwen3*` prefix to cover it, and 3.5 is known
// to drive the KV cache differently (iM-RoPE / longer thinking traces), so the
// reasoning reconciliation path needs its own end-to-end coverage and not just the
// architecture-string unit test.
const QWEN35_MODEL = {
  name: 'Qwen3.5-0.8B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
}

async function setupReasoningModel(t, toolsEnabled, opts = {}) {
  const { modelDef = MODEL, configOverrides = {} } = opts
  const [modelName, dirPath] = await ensureModel({
    modelName: modelDef.name,
    downloadUrl: modelDef.url
  })

  const modelPath = path.join(dirPath, modelName)
  const specLogger = attachSpecLogger({ forwardToConsole: true })

  const config = {
    ctx_size: '4096',
    n_predict: '1024',
    seed: '50',
    gpu_layers: '999',
    temp: '0',
    top_p: '1',
    device: useCpu ? 'cpu' : 'gpu',
    verbosity: '2',
    tools: toolsEnabled ? 'true' : 'false',
    ...configOverrides
  }

  const inference = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: console,
    opts: { stats: true }
  })

  await inference.load()

  // Only a pin that binds logs "(backend override)" with parentheses; a pin
  // that matches no device warns without them. Call after the first
  // completion: backend selection is lazy, so the log is empty right after load.
  function assertBackendPin() {
    if (!config.backend || config.device !== 'gpu') {
      return
    }
    t.ok(
      specLogger.logs.some((l) => /\(backend override\)/.test(l)),
      `${config.backend} backend pin took effect`
    )
  }

  t.teardown(async () => {
    try {
      specLogger.release()
      if (inference) await inference.unload()
    } catch (err) {
      // Ignore cleanup errors
    }
  })

  return { inference, assertBackendPin }
}

// Shared helper: Run a completion and collect response
async function runCompletion(inference, messages, runOptions) {
  const result = await inference.run(messages, runOptions)
  let response = ''
  await result
    .onUpdate((token) => {
      response += token
    })
    .await()
  return response
}

// Shared helper: Run a completion and return both response text + runtime stats.
async function runCompletionWithStats(inference, messages, runOptions) {
  const result = await inference.run(messages, runOptions)
  let response = ''
  await result
    .onUpdate((token) => {
      response += token
    })
    .await()
  return { response, stats: result.stats || {} }
}

const toNumber = (value) => (typeof value === 'number' ? value : Number(value || 0))

// Shared helper: Verify reasoning tags in response
function verifyReasoningTags(t, response, testName) {
  // Qwen3 models use <think> tags in output
  const hasOpeningTag = response.includes('<think>')
  const hasClosingTag = response.includes('</think>')
  t.ok(hasOpeningTag, `${testName} should contain opening reasoning tag`)
  t.ok(hasClosingTag, `${testName} should contain closing reasoning tag`)
  t.ok(response.length > 100, `${testName} should generate substantial output`)
}

// Shared helper: Create initial messages for reasoning test
function createInitialMessages() {
  return [
    {
      role: 'system',
      content: 'You are an AI assistant. Always provide a clear answer after thinking'
    },
    {
      role: 'user',
      content: 'what are you thinking'
    }
  ]
}

// Shared helper: Create follow-up messages
function createFollowUpMessages(initialMessages, previousResponse) {
  return [
    ...initialMessages,
    {
      role: 'assistant',
      content: previousResponse
    },
    {
      role: 'user',
      content: 'what is new'
    }
  ]
}

function stripReasoningForPrompt(response) {
  const stripped = response.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim()
  return stripped || response
}

safeTest(
  'Qwen3 reasoning-budget=0 disables thinking',
  {
    skip: isDarwinX64,
    timeout: 600_000
  },
  async (t) => {
    const [modelName, dirPath] = await ensureModel({
      modelName: MODEL.name,
      downloadUrl: MODEL.url
    })
    const modelPath = path.join(dirPath, modelName)

    const baseConfig = {
      ctx_size: '4096',
      n_predict: '1024',
      seed: '50',
      gpu_layers: '999',
      temp: '0',
      top_p: '1',
      device: useCpu ? 'cpu' : 'gpu',
      verbosity: '0'
    }

    async function runOnce(extra) {
      const inference = new LlmLlamacpp({
        files: { model: [modelPath] },
        config: { ...baseConfig, ...extra },
        logger: console
      })
      try {
        await inference.load()
        const messages = [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is the capital of France? Answer in one word.' }
        ]
        return await runCompletion(inference, messages)
      } finally {
        await inference.unload().catch(() => {})
      }
    }

    const baseline = await runOnce({})
    const disabled = await runOnce({ 'reasoning-budget': '0' })
    const disabledUnderscore = await runOnce({ reasoning_budget: '0' })

    t.comment(`baseline (${baseline.length} chars): ${baseline.slice(0, 200)}`)
    t.comment(`disabled (${disabled.length} chars): ${disabled.slice(0, 200)}`)

    t.ok(/paris/i.test(baseline), 'baseline mentions Paris')
    t.ok(/paris/i.test(disabled), 'disabled mentions Paris')
    t.ok(/paris/i.test(disabledUnderscore), 'underscore variant also accepted and mentions Paris')

    // Baseline must show balanced reasoning markers in the stream. The Qwen3
    // template force-opens <think> in the prompt suffix; the addon prepends
    // the opener so streaming consumers see a matched <think>...</think> pair.
    t.ok(
      baseline.includes('<think>'),
      `baseline should contain <think> opening tag: "${baseline.slice(0, 100)}"`
    )
    t.ok(
      baseline.includes('</think>'),
      `baseline should contain </think> closing tag: "${baseline.slice(-100)}"`
    )
    t.ok(
      baseline.indexOf('<think>') < baseline.indexOf('</think>'),
      'baseline opening tag must precede closing tag'
    )

    // With thinking disabled the visible stream skips the reasoning preamble
    // entirely, so neither marker should appear.
    t.absent(
      /<think>/.test(disabled),
      `disabled output should not contain <think>: "${disabled.slice(0, 200)}"`
    )
    t.absent(
      /<\/think>/.test(disabled),
      `disabled output should not contain </think>: "${disabled.slice(0, 200)}"`
    )
    t.ok(
      disabled.length < baseline.length / 4,
      `disabled (${disabled.length}) should be substantially shorter than baseline (${baseline.length})`
    )
  }
)

safeTest(
  'Qwen3 cached full history removes omitted reasoning lazily',
  {
    skip: isDarwinX64 || isWindowsX64,
    timeout: 900_000
  },
  async (t) => {
    const { inference } = await setupReasoningModel(t, false)
    const cacheKey = path.join(os.tmpdir(), `qvac-lazy-reasoning-${Date.now()}.bin`)
    t.teardown(() => cleanupIntegrationCacheFiles(cacheKey))

    const initial = createInitialMessages()
    const turn1 = await runCompletionWithStats(inference, initial, { cacheKey })
    verifyReasoningTags(t, turn1.response, 'turn 1')

    const visibleAnswer = stripReasoningForPrompt(turn1.response)
    const fullHistory = createFollowUpMessages(initial, visibleAnswer)
    const turn2 = await runCompletionWithStats(inference, fullHistory, { cacheKey })

    t.ok(turn2.response.length > 0, 'full-history continuation should generate')
    t.ok(toNumber(turn2.stats.CacheTokens) > 0, 'reconciled cache should remain resident')
  }
)

// A generation that fills the window while reasoning stops with
// `stopReason=contextOverflow` and keeps what it produced; a prompt that cannot
// fit at all throws. The model must stay usable after either one.
safeTest(
  'Qwen3 reasoning surfaces context overflow on both paths and recovers',
  { timeout: 600_000 },
  async (t) => {
    const { inference } = await setupReasoningModel(t, false, {
      configOverrides: {
        // Sizing and assertions are shared with `api-behavior.test.js`.
        ctx_size: String(overflow.CTX_SIZE),
        n_predict: String(overflow.PREDICT),
        // darwin-x64 Metal cannot decode again after a ContextOverflow throw.
        ...(isDarwinX64 ? { device: 'cpu' } : {})
      }
    })

    // The prompt lands just inside the window and `predict` exceeds the room
    // left, so the stop is always the full context, never the prediction cap.
    const { stats, response } = await runCompletionWithStats(
      inference,
      [{ role: 'user', content: overflow.fillerPrompt() }],
      { generationParams: { predict: overflow.PREDICT } }
    )
    t.comment(`overflow turn stats: ${JSON.stringify(stats)}`)

    overflow.assertStoppedByFullContext(t, stats, response)

    // A message that cannot fit on its own is rejected before any decode.
    let prefillError = null
    try {
      await runCompletionWithStats(
        inference,
        [{ role: 'user', content: overflow.oversizedPrompt() }],
        {
          generationParams: { reasoning_budget: 0 }
        }
      )
    } catch (err) {
      prefillError = err
    }
    overflow.assertPromptAloneRejected(t, prefillError)

    const recovery = await runCompletionWithStats(
      inference,
      [{ role: 'user', content: 'Say ok.' }],
      {
        generationParams: { reasoning_budget: 0 }
      }
    )
    t.ok(
      recovery.response.length > 0,
      'model should recover and generate after a context-overflow failure'
    )
  }
)

// Qwen3.5 coverage — exercises the reasoning detection on a hybrid SSM
// checkpoint and verifies the recurrent-memory gate keeps the cache
// untouched. Qwen3.5 thinking traces can exceed 1k tokens before
// `</think>` closes, so we give a larger n_predict / ctx_size. Greedy
// Qwen3.5-0.8B can loop inside `<think>` on the CPU backend; the budget
// force-closes the span so these tests always have one to compact. On linux
// x64, where CUDA is now preferred, they also pin Vulkan: whether the span
// closes is not stable across backends.
const QWEN35_REASONING_CONFIG = {
  ctx_size: '8192',
  n_predict: '3072',
  reasoning_budget: '1024',
  ...(os.platform() === 'linux' && os.arch() === 'x64' ? { backend: 'vulkan' } : {})
}

safeTest(
  'Qwen3.5 hybrid divergence reuses a process-local checkpoint',
  {
    skip: isDarwinX64 || isWindowsX64,
    timeout: 1_200_000
  },
  async (t) => {
    const { inference, assertBackendPin } = await setupReasoningModel(t, false, {
      modelDef: QWEN35_MODEL,
      configOverrides: QWEN35_REASONING_CONFIG
    })
    const cacheKey = path.join(os.tmpdir(), `qvac-hybrid-checkpoint-${Date.now()}.bin`)
    t.teardown(() => cleanupIntegrationCacheFiles(cacheKey))

    const initial = createInitialMessages()
    const turn1 = await runCompletionWithStats(inference, initial, { cacheKey })
    assertBackendPin()
    t.ok(turn1.response.length > 0, 'hybrid turn 1 should generate')

    const fullHistory = createFollowUpMessages(initial, stripReasoningForPrompt(turn1.response))
    const turn2 = await runCompletionWithStats(inference, fullHistory, { cacheKey })
    t.ok(turn2.response.length > 0, 'hybrid checkpoint reconciliation should generate')
    t.ok(toNumber(turn2.stats.CacheTokens) > 0, 'hybrid cache should remain resident')
  }
)
