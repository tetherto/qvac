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

function stripReasoningForPrompt (response) {
  const stripped = response.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim()
  return stripped || response
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

// Default behaviour: without any override, a Qwen3 turn that emits
// <think>...</think> should drop the thinking block from the KV cache
// at end-of-generation and report at least one thinking-block
// discard. The explicit opt-out path is covered by the "keeps
// thinking in cache" test below.
safeTest('remove_thinking_from_context defaults on for Qwen3', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 600_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false)

  const messages = createInitialMessages()
  const { response, stats } = await runCompletionWithStats(inference, messages)
  t.comment(`response (len=${response.length}): ${response.slice(0, 200)}...`)
  t.comment(`stats: ${JSON.stringify(stats)}`)

  verifyReasoningTags(t, response, 'default (compaction on)')

  const thinkingDiscards = toNumber(stats.thinkingBlockDiscards)
  t.ok(thinkingDiscards >= 1,
    `default run should report at least one compaction (got ${thinkingDiscards})`)
})

// Explicit-true path: passing `remove_thinking_from_context: true`
// reaffirms the default and pins the compaction plumbing regardless
// of any future default change. Complements the "defaults on" test
// above by exercising the override path rather than the default.
safeTest('remove_thinking_from_context=true compacts reasoning span for Qwen3', {
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
// `remove_thinking_from_context` overrides independently. Slot A
// re-affirms the default-on (1 discard), slot B explicitly opts out
// with `remove_thinking_from_context: false` (0 discards); the
// scheduler's `accumulateSlotRuntimeStats` sums per-slot
// `getThinkingBlockDiscards()` so the aggregate must be exactly 1.
// Both overrides are set explicitly so the test remains valid
// regardless of any future default change.
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
      ],
      // Explicit opt-out: pins slot B at 0 discards so the aggregate
      // assertion below stays anchored to slot A's single discard.
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
  t.comment(`mixed-slot batch stats: ${JSON.stringify(stats)}`)

  for (const item of batchInput) {
    const output = outputsById.get(item.id) || ''
    t.comment(`mixed-slot ${item.id} (len=${output.length}): ${output.slice(0, 160)}...`)
    t.ok(output.includes('<think>') && output.includes('</think>'),
      `mixed-slot ${item.id} output should contain <think>...</think>`)
  }

  // Slot A (explicit-on) contributes 1; slot B (explicit-off) contributes 0.
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

// Qwen3.5 is a hybrid SSM family. The recurrent half is rolled back
// via a disk-backed full-state snapshot taken at the prefill boundary,
// restored at end-of-generation, and the post-reasoning tail is
// replayed through `llama_decode` so the SSM advances over it without
// absorbing the dropped span. The previous hard rejection has been
// removed; this test pins the success path.
safeTest('Qwen3.5 honours remove_thinking_from_context opt-in', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 900_000
}, async t => {
  const { inference } = await setupReasoningModel(t, false, {
    modelDef: QWEN35_MODEL,
    configOverrides: QWEN35_REASONING_CONFIG
  })

  const messages = createInitialMessages()

  const { response, stats } = await runCompletionWithStats(
    inference,
    messages,
    { generationParams: { remove_thinking_from_context: true } }
  )
  t.comment(`response (len=${response.length}): ${response.slice(0, 200)}...`)
  t.comment(`stats: ${JSON.stringify(stats)}`)

  // The model produced visible reasoning tags during generation — the
  // compactor only drops a span if `<think>...</think>` actually fired.
  verifyReasoningTags(t, response, 'Qwen3.5 opt-in')

  const thinkingDiscards = toNumber(stats.thinkingBlockDiscards)
  // Under the uniform hard-fail contract (PR #2813), any compaction
  // failure would have thrown `StatusError` from the `run()` call
  // above; reaching this point means recurrent restore + replay
  // succeeded.
  t.ok(thinkingDiscards >= 1,
    `opt-in run should report at least one discard (got ${thinkingDiscards})`)
})

// Multi-turn assertion that the SSM rollback is doing its job: with
// compaction ON, the persisted cache should remain usable on the next turn
// without being steered by turn 1's reasoning span. The explicit assistant
// message mirrors the compacted cache by stripping the visible reasoning body
// from the prompt.
safeTest('Qwen3.5 multi-turn with remove_thinking_from_context is reasoning-clean', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 1_500_000
}, async t => {
  const sessionPath = path.join(os.tmpdir(), `qvac-qwen35-reasoning-clean-${Date.now()}.bin`)
  t.teardown(() => {
    try {
      require('bare-fs').unlinkSync(sessionPath)
    } catch {
    }
  })

  const { inference } = await setupReasoningModel(
    t, false,
    { modelDef: QWEN35_MODEL, configOverrides: QWEN35_REASONING_CONFIG })

  const messagesT1 = createInitialMessages()

  const t1 = await runCompletionWithStats(inference, messagesT1, {
    cacheKey: sessionPath,
    generationParams: { remove_thinking_from_context: true }
  })
  t.comment(`turn 1 stats: ${JSON.stringify(t1.stats)}`)
  t.ok(toNumber(t1.stats.thinkingBlockDiscards) >= 1,
    'turn 1 should drop at least one reasoning block')

  const messagesT2 =
    [
      ...messagesT1,
      // The live cache was compacted, so the explicit assistant message used to
      // render turn 2 must mirror that compacted history rather than
      // re-injecting turn 1's long reasoning body into the prompt.
      { role: 'assistant', content: stripReasoningForPrompt(t1.response) },
      { role: 'user', content: 'Now tell me the capital of Spain.' }
    ]

  const t2 = await runCompletionWithStats(inference, messagesT2, {
    cacheKey: sessionPath,
    generationParams: {
      // Turn 2 is a recovery/continuation check. Keep it out of Qwen3.5's
      // long thinking path so an unfinished second-turn span does not mask
      // the compacted-cache assertion from turn 1.
      reasoning_budget: 0,
      remove_thinking_from_context: true
    }
  })
  t.comment(`turn 2 stats: ${JSON.stringify(t2.stats)}`)
  t.comment(
    `turn 2 response (len=${t2.response.length}): ${t2.response.slice(0, 300)}`)
  t.ok(
    t2.response.length > 0,
    'turn 2 should still produce a response (generation succeeds after rollback)')

  // Functional check on the answer itself. If turn 1's compacted cache is
  // corrupted or still contains hidden reasoning state, this deterministic
  // follow-up tends to drift off-topic or loop instead of answering Madrid.
  t.ok(/madrid/i.test(t2.response),
    'turn 2 should answer "capital of Spain" with Madrid (proves the SSM did not degenerate)')
})

// `runtimeStats()` reports a per-inference user-visible perf snapshot
// captured at the start of `compactThinkSpan`. On hybrid SSM models
// the compactor then runs `restore + llama_decode` to replay the post-
// reasoning tail through the SSM; without the snapshot, those replay
// decodes accumulate into `n_p_eval` / `t_p_eval_ms` and inflate
// user-facing `promptTokens` (and `ppTPS` / `TTFT`) by the replay
// length. This regression test pins the contract by running the same
// prompt + seed twice on Qwen3.5 with compaction toggled. Both runs
// share the same prefill, so a non-inflated `promptTokens` must match
// to within the noise floor introduced by per-instance load
// determinism — the `=false` baseline gives the true prefill count
// without any replay path. Without the snapshot the `=true` run is
// strictly larger; with the snapshot the two runs report the same
// `promptTokens`.
safeTest('Qwen3.5 remove_thinking_from_context does not inflate runtime perf stats', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 1_800_000
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN35_MODEL.name,
    downloadUrl: QWEN35_MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)

  const baseConfig = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    seed: '50',
    temp: '0',
    top_p: '1',
    verbosity: '2',
    ...QWEN35_REASONING_CONFIG
  }

  async function runOnce (removeThinking) {
    const inference = new LlmLlamacpp({
      files: { model: [modelPath] },
      config: baseConfig,
      logger: console,
      opts: { stats: true }
    })
    try {
      await inference.load()
      const messages = createInitialMessages()
      const { stats } = await runCompletionWithStats(
        inference,
        messages,
        { generationParams: { remove_thinking_from_context: removeThinking } }
      )
      return stats
    } finally {
      await inference.unload().catch(() => {})
    }
  }

  // Baseline first: compaction off, no replay decode, perf counters
  // reflect a clean prefill.
  const off = await runOnce(false)
  t.comment(`compaction=off stats: ${JSON.stringify(off)}`)

  // Then with compaction on. Same prompt + seed + cfg, so the prefill
  // token count is byte-for-byte identical. The only difference is
  // that the hybrid replay decode runs after generation.
  const on = await runOnce(true)
  t.comment(`compaction=on  stats: ${JSON.stringify(on)}`)

  // Under the uniform hard-fail contract (PR #2813), a compaction
  // failure would have thrown from the `run()` call above; reaching
  // this point means the snapshot-and-replay path succeeded.
  t.ok(toNumber(on.thinkingBlockDiscards) >= 1,
    'compaction-on run must actually drop a reasoning block (otherwise no replay decode ran)')

  // The contract: `promptTokens` reflects the user-visible prefill,
  // NOT the prefill plus the replayed post-reasoning tail. With the
  // snapshot fix the two runs match; without it the compaction-on run
  // is strictly larger by the replay length.
  t.is(toNumber(on.promptTokens), toNumber(off.promptTokens),
    `promptTokens must match between compaction on/off (on=${on.promptTokens}, off=${off.promptTokens}); ` +
    'a larger on-value means the recurrent replay decode was counted as user-visible prompt work')
})

// Continuous-batching counterpart of the perf-stats test above. The batch
// runtime stats path used to source `TTFT` from the shared
// `llama_perf_context().t_p_eval_ms`, which is read AFTER slot
// finalization runs `onGenerationFinished -> compactThinkSpan -> restore
// + llama_decode` (the replay decode). For hybrid models that inflated
// batch TTFT by the entire replay decode time. The fix sources batch
// TTFT from scheduler-owned `prefillTimeMs` (only pure-prefill batch
// steps; the compactor's replay does not go through `recordDecodeStep`).
//
// We assert the contract by running the same prompt twice through the
// batch path — once with compaction OFF (no replay, clean TTFT) and once
// with compaction ON (replay fires, TTFT should still be clean). The
// scheduler is engaged via `parallel: 2`. A regression where batch TTFT
// falls back to live perf counters would show as on-run TTFT being
// strictly larger than off-run TTFT by the replay-decode time.
safeTest('Qwen3.5 batch path does not inflate TTFT with recurrent replay', {
  skip: isDarwinX64 || isWindowsX64,
  timeout: 1_800_000
}, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: QWEN35_MODEL.name,
    downloadUrl: QWEN35_MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)

  // `parallel: '2'` enables the continuous-batching scheduler so
  // `inference.run([...])` flows through `batchRuntimeStatsLocked`
  // (not `singleRuntimeStatsLocked`), which is the path under test.
  const baseConfig = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    seed: '50',
    temp: '0',
    top_p: '1',
    verbosity: '2',
    parallel: '2',
    ...QWEN35_REASONING_CONFIG
  }

  async function runBatchOnce (removeThinking) {
    const inference = new LlmLlamacpp({
      files: { model: [modelPath] },
      config: baseConfig,
      logger: console,
      opts: { stats: true }
    })
    try {
      await inference.load()
      const batchInput = [{
        id: 'q-france',
        prompt: createInitialMessages(),
        runOptions: { generationParams: { remove_thinking_from_context: removeThinking } }
      }]
      const batchResponse = await inference.run(batchInput)
      const results = await batchResponse.await()
      const output = results.length > 0 ? (results[0].output || '') : ''
      return { stats: batchResponse.stats || {}, output }
    } finally {
      await inference.unload().catch(() => {})
    }
  }

  // Baseline: no compaction, no replay decode in onGenerationFinished.
  // Whatever TTFT the batch reports here is the true prefill cost on
  // this host.
  const off = await runBatchOnce(false)
  t.comment(`batch compaction=off stats: ${JSON.stringify(off.stats)}`)

  const on = await runBatchOnce(true)
  t.comment(`batch compaction=on  stats: ${JSON.stringify(on.stats)}`)

  // Under the uniform hard-fail contract (PR #2813), a compaction
  // failure would have thrown from the batch `run()` call above;
  // reaching this point means the replay path succeeded on the slot.
  t.ok(toNumber(on.stats.thinkingBlockDiscards) >= 1,
    'compaction-on batch must actually drop a reasoning block (otherwise no replay decode ran)')

  // Batch TTFT and ppTPS are both derived from the same scheduler-owned
  // prefill timer. Pin that internal contract instead of comparing two
  // independent wall-clock runs: the off/on comparison is noisy on fast GPU
  // hosts, while this invariant breaks if TTFT falls back to llama.cpp perf
  // counters that include recurrent replay decode.
  const ttftOff = toNumber(off.stats.TTFT)
  const ttftOn = toNumber(on.stats.TTFT)
  t.ok(ttftOff > 0,
    `batch off-run must report a non-zero TTFT (got ${ttftOff})`)
  t.ok(ttftOn > 0,
    `batch on-run must report a non-zero TTFT (got ${ttftOn})`)
  const promptTokensOn = toNumber(on.stats.promptTokens)
  const ppTpsOn = toNumber(on.stats.ppTPS)
  t.ok(ppTpsOn > 0,
    `batch on-run must report non-zero ppTPS (got ${ppTpsOn})`)
  const derivedPrefillMs = (1000 * promptTokensOn) / ppTpsOn
  const ttftDiff = Math.abs(ttftOn - derivedPrefillMs)
  t.ok(ttftDiff <= 0.001,
    `batch TTFT (${ttftOn}ms) must match scheduler prefill time derived from ` +
    `promptTokens/ppTPS (${derivedPrefillMs}ms, diff=${ttftDiff}ms)`)

  // promptTokens is scheduler-owned (populated by `accumulateSlot` from
  // `prefillTokenCount`, not from `llama_perf_context`), so this should
  // match identically — same prompt, same seed.
  t.is(toNumber(on.stats.promptTokens), toNumber(off.stats.promptTokens),
    `batch promptTokens must match between compaction on/off (on=${on.stats.promptTokens}, off=${off.stats.promptTokens})`)
})

// ContextShifter invalidates reasoning spans whenever a generation-time slide
// drops cache tokens. Under the uniform hard-fail contract (PR #2813), a
// slide that invalidates active reasoning state must reject the request
// instead of silently preserving reasoning in cache. This test forces that
// interaction and asserts the failure is explicit and recoverable.
//
// We force the slide by squeezing `ctx_size` down to 512 (and setting
// `n_discarded=64` so overflow triggers a slide instead of a hard
// error) and running multiple turns whose cumulative tokens overflow
// that budget. The chat-template wrapping plus turn-1 reasoning output
// is enough to push later turns past the ctx limit on Qwen3-0.6B — a
// slide must fire to make room. Without compaction-aware slide
// handling used to crash on span-end-out-of-cache assertions; with the strict
// contract it surfaces as a `slide invalidated tracked reasoning state`
// error.
safeTest(
  'Qwen3 sliding context hard-fails stale reasoning compaction',
  { timeout: 600_000 }, async t => {
    const { inference } = await setupReasoningModel(t, false, {
      configOverrides: {
        // Tight ctx so the cumulative cache from multi-turn overflows
        // ctx_size and ContextShifter is forced to run. 512 rounds up to
        // the next 256 multiple, matching the budget used by
        // sliding-context.test.js. `n_discarded > 0` is required to
        // enable sliding (the default of 0 turns overflow into a hard
        // error).
        ctx_size: '512',
        n_predict: '512',
        n_discarded: '64'
      }
    })

    // Per-turn output cap. Each `inference.run` starts with a fresh KV
    // cache, so every turn re-tokenizes the full conversation and
    // prefills it as a single delta. With the default `n_predict=512`,
    // a single verbose turn (observed >300 tokens on Android
    // Qwen3-0.6B) pushes turn 2's tokenized prompt past ctx_size and
    // trips the prefill-time hard-overflow guard before any slide can
    // fire. Capping per-turn output keeps every turn's tokenized prompt
    // under ctx_size (so the hard guard never fires) while letting
    // cumulative cache growth during decode cross the ceiling — which
    // is where the slide is expected to fire on this test.
    //
    // Sizing: initial ~40 + 4 x (PER_TURN_PREDICT + 25) + 25 must stay
    // safely below 512 on turn 5's prefill, and turn-5 nPast + predict
    // must exceed 512 so decode triggers the slide.
    const PER_TURN_PREDICT = 80

    // Drive turns sequentially, accumulating the full conversation in
    // `messages`. Each turn issues a fresh `inference.run`, so the cache
    // grows monotonically across turns and eventually trips a
    // generation-time slide while reasoning state is active.
    const messages = createInitialMessages()
    let lastStats = {}
    let lastResponse = ''
    let firstError = null

    // Five turns is a comfortable upper bound — every additional turn
    // roughly doubles cumulative tokens at this prompt scale, so the
    // cache crosses 512 within 2–3 turns on every backend we test.
    for (let turn = 1; turn <= 5 && firstError === null; turn++) {
      let turnStats = {}
      let turnResponse = ''
      try {
        const result = await runCompletionWithStats(inference, messages, {
          generationParams: {
            remove_thinking_from_context: true,
            predict: PER_TURN_PREDICT
          }
        })
        turnStats = result.stats
        turnResponse = result.response
      } catch (err) {
        firstError = firstError || err
        break
      }
      lastStats = turnStats
      lastResponse = turnResponse
      t.comment(`turn ${turn} stats: ${JSON.stringify(turnStats)}`)
      t.comment(`turn ${turn} response (len=${turnResponse.length}): ${
              turnResponse.slice(0, 120)}`)

      messages.push({ role: 'assistant', content: turnResponse })
      messages.push({
        role: 'user',
        content:
                'Please elaborate further on the previous answer in great detail, covering all relevant background.'
      })
    }

    t.ok(
      firstError,
            `multi-turn sliding run must trigger a strict compaction failure (last stats=${
                JSON.stringify(
                    lastStats)}, last response len=${lastResponse.length})`)
    t.ok(
      /slide invalidated tracked reasoning state/i.test(
        firstError && firstError.message),
            `slide failure should explain the invalidated reasoning state, got: ${
                firstError && firstError.message}`)

    const recovery = await runCompletionWithStats(
      inference, [{ role: 'user', content: 'Say ok.' }], {
        generationParams:
                  { reasoning_budget: 0, remove_thinking_from_context: true }
      })
    t.ok(
      recovery.response.length > 0,
      'model should recover and generate after strict slide-invalidation failure')
  })
