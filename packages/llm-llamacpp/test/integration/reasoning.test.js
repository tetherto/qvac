'use strict'

const path = require('bare-path')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
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
// compaction path needs its own end-to-end coverage and not just the
// architecture-string unit test.
const QWEN35_MODEL = {
  name: 'Qwen3.5-0.8B-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
}

async function setupReasoningModel (t, toolsEnabled, opts = {}) {
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

  t.teardown(async () => {
    try {
      specLogger.release()
      if (inference) await inference.unload()
    } catch (err) {
      // Ignore cleanup errors
    }
  })

  return { inference }
}

// Shared helper: Run a completion and collect response
async function runCompletion (inference, messages, runOptions) {
  const result = await inference.run(messages, runOptions)
  let response = ''
  await result
    .onUpdate(token => {
      response += token
    })
    .await()
  return response
}

// Shared helper: Run a completion and return both response text + runtime stats.
async function runCompletionWithStats (inference, messages, runOptions) {
  const result = await inference.run(messages, runOptions)
  let response = ''
  await result
    .onUpdate(token => { response += token })
    .await()
  return { response, stats: result.stats || {} }
}

const toNumber = value => typeof value === 'number' ? value : Number(value || 0)

// Shared helper: Verify reasoning tags in response
function verifyReasoningTags (t, response, testName) {
  // Qwen3 models use <think> tags in output
  const hasOpeningTag = response.includes('<think>')
  const hasClosingTag = response.includes('</think>')
  t.ok(hasOpeningTag,
    `${testName} should contain opening reasoning tag`)
  t.ok(hasClosingTag,
    `${testName} should contain closing reasoning tag`)
  t.ok(response.length > 100,
    `${testName} should generate substantial output`)
}

// Shared helper: Verify generation continued after reasoning
function verifyContinuedAfterReasoning (t, response, testName) {
  const thinkCloseIndex = response.indexOf('</think>')
  if (thinkCloseIndex === -1) {
    t.fail(`No </think> tag found in ${testName}`)
    return false
  }

  const textAfterThink = response.substring(thinkCloseIndex + '</think>'.length).trim()
  t.ok(textAfterThink.length > 0,
    `Generation should continue after </think> tag (${testName})`)
  return textAfterThink.length > 0
}

// Shared helper: Create initial messages for reasoning test
function createInitialMessages () {
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
function createFollowUpMessages (initialMessages, previousResponse) {
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

safeTest('reasoning tag EOS replacement works with tools=false', {
  skip: isDarwinX64,
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false)

  // First completion - should work correctly
  const messages1 = createInitialMessages()
  const response1 = await runCompletion(inference, messages1)
  t.comment(`First completion (tools=false, len=${response1.length}):\n${response1}`)
  verifyReasoningTags(t, response1, 'First completion')

  // Second completion - this is where the fix should activate
  const messages2 = createFollowUpMessages(messages1, response1)
  const response2 = await runCompletion(inference, messages2)
  t.comment(`Second completion (tools=false, len=${response2.length}):\n${response2}`)

  verifyReasoningTags(t, response2, 'Second completion')

  // Verify the fix worked: generation continued after reasoning
  verifyContinuedAfterReasoning(t, response2, 'tools=false')
})

safeTest('reasoning tag EOS replacement works with tools=true', {
  skip: isDarwinX64,
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, true)

  // First completion - should work correctly
  const messages1 = createInitialMessages()
  const response1 = await runCompletion(inference, messages1)
  t.comment(`First completion (tools=true, len=${response1.length}):\n${response1}`)
  verifyReasoningTags(t, response1, 'First completion (tools=true)')

  // Second completion - this is where the fix should activate
  const messages2 = createFollowUpMessages(messages1, response1)
  const response2 = await runCompletion(inference, messages2)
  t.comment(`Second completion (tools=true, len=${response2.length}):\n${response2}`)

  verifyReasoningTags(t, response2, 'Second completion (tools=true)')

  // Verify the fix worked: generation continued after reasoning
  verifyContinuedAfterReasoning(t, response2, 'tools=true')
})

safeTest('Qwen3 reasoning-budget=0 disables thinking', {
  skip: isDarwinX64,
  timeout: 600_000
}, async t => {
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

  async function runOnce (extra) {
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
  t.ok(baseline.includes('<think>'),
    `baseline should contain <think> opening tag: "${baseline.slice(0, 100)}"`)
  t.ok(baseline.includes('</think>'),
    `baseline should contain </think> closing tag: "${baseline.slice(-100)}"`)
  t.ok(baseline.indexOf('<think>') < baseline.indexOf('</think>'),
    'baseline opening tag must precede closing tag')

  // With thinking disabled the visible stream skips the reasoning preamble
  // entirely, so neither marker should appear.
  t.absent(/<think>/.test(disabled),
    `disabled output should not contain <think>: "${disabled.slice(0, 200)}"`)
  t.absent(/<\/think>/.test(disabled),
    `disabled output should not contain </think>: "${disabled.slice(0, 200)}"`)
  t.ok(disabled.length < baseline.length / 4,
    `disabled (${disabled.length}) should be substantially shorter than baseline (${baseline.length})`)
})

// Default behaviour: without opting in, a Qwen3 turn that emits
// <think>...</think> should leave the thinking block in the cache and
// report 0 thinking-block discards. The opt-in path is covered by the
// next test, and the cross-turn effect by the multi-turn test below.
safeTest('remove_thinking_from_context defaults off for Qwen3', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false)

  const messages = createInitialMessages()
  const { response, stats } = await runCompletionWithStats(inference, messages)
  t.comment(`response (len=${response.length}): ${response.slice(0, 200)}...`)
  t.comment(`stats: ${JSON.stringify(stats)}`)

  verifyReasoningTags(t, response, 'default (no compaction)')

  const thinkingDiscards = toNumber(stats.thinkingBlockDiscards)
  t.is(thinkingDiscards, 0,
    `default run should report 0 discards (got ${thinkingDiscards})`)
})

// Opt-in path: explicitly enabling the toggle drops the reasoning span
// from the KV cache. Mirrors the "defaults off" test but flips the flag.
safeTest('remove_thinking_from_context=true opts into compaction for Qwen3', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false)

  const messages = createInitialMessages()
  const { response, stats } = await runCompletionWithStats(
    inference,
    messages,
    { generationParams: { remove_thinking_from_context: true } }
  )
  t.comment(`response (len=${response.length}): ${response.slice(0, 200)}...`)
  t.comment(`stats: ${JSON.stringify(stats)}`)

  verifyReasoningTags(t, response, 'opt-in compaction')

  const thinkingDiscards = toNumber(stats.thinkingBlockDiscards)
  t.ok(thinkingDiscards >= 1,
    `opt-in run should report at least one compaction (got ${thinkingDiscards})`)
})

// Opt-out path: when the caller explicitly disables the compaction, the
// runtime stats should report no discards and the cache should retain the
// full prompt + generated span (modulo the existing protected-first-message
// trimming the tools_compact controller already performs).
safeTest('remove_thinking_from_context=false keeps thinking in cache', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false)

  const messages = createInitialMessages()
  const { response, stats } = await runCompletionWithStats(
    inference,
    messages,
    { generationParams: { remove_thinking_from_context: false } }
  )
  t.comment(`response (len=${response.length}): ${response.slice(0, 200)}...`)
  t.comment(`stats: ${JSON.stringify(stats)}`)

  verifyReasoningTags(t, response, 'compaction disabled')

  const thinkingDiscards = toNumber(stats.thinkingBlockDiscards)
  t.is(thinkingDiscards, 0,
    `compaction disabled should report 0 discards (got ${thinkingDiscards})`)
})

// Batch path opt-out: when the continuous-batching scheduler admits a
// request with `remove_thinking_from_context: false`, the per-slot driver
// must honour the toggle. Aggregated batch stats sum across slots, so a
// 0 here proves no slot dropped its thinking block.
safeTest('remove_thinking_from_context=false is honoured in batch path', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false, { configOverrides: { parallel: '2' } })

  const batchInput = [
    {
      id: 'q-france',
      prompt: createInitialMessages(),
      runOptions: { generationParams: { remove_thinking_from_context: false } }
    },
    {
      id: 'q-spain',
      prompt: [
        { role: 'system', content: 'You are an AI assistant. Always provide a clear answer after thinking' },
        { role: 'user', content: 'What is the capital of Spain?' }
      ],
      runOptions: { generationParams: { remove_thinking_from_context: false } }
    }
  ]

  const batchResponse = await inference.run(batchInput)
  const outputsById = new Map()
  await batchResponse
    .onUpdate(({ id, chunk }) => {
      outputsById.set(id, (outputsById.get(id) || '') + chunk)
    })
    .await()
  const stats = batchResponse.stats || {}
  t.comment(`batch stats: ${JSON.stringify(stats)}`)

  for (const item of batchInput) {
    const output = outputsById.get(item.id) || ''
    t.comment(`batch ${item.id} (len=${output.length}): ${output.slice(0, 160)}...`)
    t.ok(output.includes('<think>') && output.includes('</think>'),
      `batch ${item.id} should retain <think>...</think> tags`)
  }

  const thinkingDiscards = toNumber(stats.thinkingBlockDiscards)
  t.is(thinkingDiscards, 0,
    `batch path with compaction disabled should report 0 discards (got ${thinkingDiscards})`)
})

// Mixed-slot batch path: per-slot drivers honour their own
// `remove_thinking_from_context` overrides independently. Slot A opts in
// (1 discard), slot B leaves the toggle at its default-off (0 discards);
// the scheduler's `accumulateSlotRuntimeStats` sums per-slot
// `getThinkingBlockDiscards()` so the aggregate must be exactly 1.
safeTest('batch path aggregates per-slot remove_thinking_from_context independently', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false, { configOverrides: { parallel: '2' } })

  const batchInput = [
    {
      id: 'slot-on',
      prompt: createInitialMessages(),
      runOptions: { generationParams: { remove_thinking_from_context: true } }
    },
    {
      id: 'slot-off',
      prompt: [
        { role: 'system', content: 'You are an AI assistant. Always provide a clear answer after thinking' },
        { role: 'user', content: 'What is the capital of Spain?' }
      ]
      // No runOptions → compaction stays at its default-off for this slot.
    }
  ]

  const batchResponse = await inference.run(batchInput)
  const outputsById = new Map()
  await batchResponse
    .onUpdate(({ id, chunk }) => {
      outputsById.set(id, (outputsById.get(id) || '') + chunk)
    })
    .await()
  const stats = batchResponse.stats || {}
  t.comment(`mixed-slot batch stats: ${JSON.stringify(stats)}`)

  for (const item of batchInput) {
    const output = outputsById.get(item.id) || ''
    t.comment(`mixed-slot ${item.id} (len=${output.length}): ${output.slice(0, 160)}...`)
    t.ok(output.includes('<think>') && output.includes('</think>'),
      `mixed-slot ${item.id} output should contain <think>...</think>`)
  }

  // Slot A (opt-in) contributes 1; slot B (default-off) contributes 0.
  // Sum across slots must equal 1 — proves per-slot independence AND
  // that `accumulateSlot` actually sums the per-slot value (not max / overwrite).
  const thinkingDiscards = toNumber(stats.thinkingBlockDiscards)
  t.is(thinkingDiscards, 1,
    'mixed-slot batch should aggregate to exactly 1 discard ' +
    `(slot-on=1, slot-off=0), got ${thinkingDiscards}`)
})

// reasoning_budget=0 short-circuits the channel before any tokens are
// emitted, so the compaction feature has nothing to do and reports 0
// discards even when `remove_thinking_from_context: true` is opted in.
safeTest('remove_thinking_from_context is a no-op when reasoning_budget=0', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false)

  const messages = createInitialMessages()
  const { response, stats } = await runCompletionWithStats(
    inference,
    messages,
    {
      generationParams: {
        reasoning_budget: 0,
        remove_thinking_from_context: true
      }
    }
  )
  t.comment(`response (len=${response.length}): ${response.slice(0, 200)}...`)
  t.comment(`stats: ${JSON.stringify(stats)}`)

  const thinkingDiscards = toNumber(stats.thinkingBlockDiscards)
  t.is(thinkingDiscards, 0,
    `reasoning_budget=0 should report 0 discards (got ${thinkingDiscards})`)
  t.absent(/<think>/.test(response),
    `reasoning_budget=0 output should not contain <think>: "${response.slice(0, 200)}"`)
})

// Multi-turn cache growth comparison. Uses a `cacheKey` so the KV cache
// persists across `run()` calls (without it the addon resets `nPast_` to 0
// after every inference and the cross-turn effect is invisible). Runs the
// same two-turn flow twice: once with compaction explicitly opted in and
// once with compaction off; the off run should have a larger residual cache.
safeTest('remove_thinking_from_context reduces multi-turn cache growth', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 1_200_000
}, async t => {
  const sessionA = path.join(os.tmpdir(), `qvac-think-compact-on-${Date.now()}.bin`)
  const sessionB = path.join(os.tmpdir(), `qvac-think-compact-off-${Date.now() + 1}.bin`)

  t.teardown(() => {
    for (const p of [sessionA, sessionB]) {
      try { require('bare-fs').unlinkSync(p) } catch {}
    }
  })

  const messages1 = createInitialMessages()
  const overridesOn = { generationParams: { remove_thinking_from_context: true } }

  // Run A — compaction ON (explicit opt-in).
  const { inference: infA } = await setupReasoningModel(t, false)
  const a1 = await runCompletionWithStats(infA, messages1, { cacheKey: sessionA, ...overridesOn })
  verifyReasoningTags(t, a1.response, 'A turn 1')
  t.ok(toNumber(a1.stats.thinkingBlockDiscards) >= 1,
    'A turn 1 should compact at least one thinking block')
  const a2 = await runCompletionWithStats(
    infA,
    createFollowUpMessages(messages1, a1.response),
    { cacheKey: sessionA, ...overridesOn }
  )
  verifyReasoningTags(t, a2.response, 'A turn 2')
  // Symmetric guard on turn 2: the cross-turn delta below assumes BOTH
  // turns of run A produced and compacted a thinking block. Without this
  // guard, a turn-2 that silently skipped thinking would still pass the
  // `cacheA2 < cacheB2` assertion (turn-1 delta alone is enough), but the
  // test would have lost half its discriminating power.
  t.ok(toNumber(a2.stats.thinkingBlockDiscards) >= 1,
    'A turn 2 should also compact at least one thinking block')

  // Run B — same flow, compaction OFF.
  const { inference: infB } = await setupReasoningModel(t, false)
  const overridesOff = { generationParams: { remove_thinking_from_context: false } }
  const b1 = await runCompletionWithStats(
    infB,
    messages1,
    { cacheKey: sessionB, ...overridesOff }
  )
  verifyReasoningTags(t, b1.response, 'B turn 1')
  t.is(toNumber(b1.stats.thinkingBlockDiscards), 0,
    'B turn 1 with compaction off should report 0 discards')
  const b2 = await runCompletionWithStats(
    infB,
    createFollowUpMessages(messages1, b1.response),
    { cacheKey: sessionB, ...overridesOff }
  )
  verifyReasoningTags(t, b2.response, 'B turn 2')

  const cacheA2 = toNumber(a2.stats.CacheTokens)
  const cacheB2 = toNumber(b2.stats.CacheTokens)
  t.comment(`compaction ON  turn 2 cache=${cacheA2} stats=${JSON.stringify(a2.stats)}`)
  t.comment(`compaction OFF turn 2 cache=${cacheB2} stats=${JSON.stringify(b2.stats)}`)

  t.ok(cacheA2 > 0, `compaction-on turn 2 should have non-zero cache (got ${cacheA2})`)
  t.ok(cacheB2 > 0, `compaction-off turn 2 should have non-zero cache (got ${cacheB2})`)
  t.ok(cacheA2 < cacheB2,
    `turn 2 cache with compaction ON (${cacheA2}) should be < OFF (${cacheB2}) — proves turn 1 thinking was dropped from the cache`)
})

// Qwen3.5 coverage — exercises the reasoning detection on a hybrid SSM
// checkpoint and verifies the recurrent-memory gate keeps the cache
// untouched. Qwen3.5 thinking traces can exceed 1k tokens before
// `</think>` closes, so we give a larger n_predict / ctx_size.
const QWEN35_REASONING_CONFIG = {
  ctx_size: '8192',
  n_predict: '3072'
}

// Qwen3.5 is a hybrid SSM family. `setRemoveThinkingFromContext(true)`
// rejects on this model because `seq_rm + seq_add` leaves the SSM
// hidden state contaminated. The leaving-it-off path still works.
safeTest('Qwen3.5 rejects remove_thinking_from_context opt-in', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 900_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false, {
    modelDef: QWEN35_MODEL,
    configOverrides: QWEN35_REASONING_CONFIG
  })

  const messages = createInitialMessages()

  let caught = null
  try {
    await runCompletionWithStats(
      inference,
      messages,
      { generationParams: { remove_thinking_from_context: true } }
    )
  } catch (err) {
    caught = err
  }
  t.ok(caught, 'opt-in on Qwen3.5 should throw')
  t.ok(/recurrent memory|SSM/i.test(caught?.message || ''),
    `error message should mention recurrent / SSM (got: ${caught?.message})`)
  // The default-off "still works" assertion lives in the leak-guard
  // test below, which also covers a Qwen3.5 follow-up after a throwing
  // request and asserts generatedTokens > 1.
})

// Regression guard for the partial-mutation leak: when the rejection
// throws *after* `applyGenerationParamsToContext` has committed
// sampler / common-params overrides, the restore lambda is never
// returned and those mutations would leak into the next request. We
// pair `remove_thinking_from_context: true` with a distinctive
// `n_predict: 1` override; if the leak existed the follow-up
// (no overrides) would inherit the n_predict=1 cap.
safeTest('Qwen3.5 reject does not leak other generation overrides', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 900_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false, {
    modelDef: QWEN35_MODEL,
    configOverrides: QWEN35_REASONING_CONFIG
  })

  const messages = createInitialMessages()

  let caught = null
  try {
    await runCompletionWithStats(
      inference,
      messages,
      { generationParams: { remove_thinking_from_context: true, n_predict: 1 } }
    )
  } catch (err) {
    caught = err
  }
  t.ok(caught, 'paired override should throw')

  // Follow-up request with no overrides — must generate beyond 1 token.
  // If the n_predict=1 from the throwing request leaked, this would be
  // capped at 1.
  const { stats } = await runCompletionWithStats(inference, messages)
  const generated = toNumber(stats.generatedTokens)
  t.comment(`follow-up generatedTokens=${generated}`)
  t.ok(generated > 1,
    `follow-up should not inherit n_predict=1 from the throwing request (got ${generated})`)
})
