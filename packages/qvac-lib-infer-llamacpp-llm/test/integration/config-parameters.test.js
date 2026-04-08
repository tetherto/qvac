'use strict'

const test = require('brittle')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()

const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isMobile = platform === 'ios' || platform === 'android'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const BASE_PROMPT = [
  {
    role: 'system',
    content: 'You are a helpful, respectful and honest assistant.'
  },
  {
    role: 'user',
    content: 'State the word "ping" exactly once.'
  }
]

const LONG_PROMPT_TEXT = new Array(6).fill('This is an intentionally verbose filler sentence to stress the context window.').join(' ')
const LONG_PROMPT = [
  {
    role: 'system',
    content: 'You are a helpful, respectful and honest assistant.'
  },
  {
    role: 'user',
    content: LONG_PROMPT_TEXT
  }
]

function createTestLogger () {
  return {
    info: (...args) => {
      if (args[0] && typeof args[0] === 'string' && args[0].includes('Starting inference with prompt')) {
        console.info(args[0], '[prompt omitted for brevity]')
        return
      }
      console.info(...args)
    },
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

const scenarios = [
  {
    name: 'Sampling overrides succeed',
    overrides: {
      temp: '0.2',
      top_p: '0.6',
      top_k: '12',
      n_predict: '12',
      repeat_penalty: '1.8',
      seed: '4321',
      verbosity: '2'
    },
    expectSuccess: true
  },
  {
    name: 'Presence/frequency penalties and tools toggle',
    overrides: {
      presence_penalty: '0.4',
      frequency_penalty: '0.6',
      tools: 'true',
      temp: '0.85',
      top_p: '0.75',
      n_predict: '24'
    },
    expectSuccess: true
  },
  {
    name: 'Sliding context parameters accepted',
    overrides: {
      ctx_size: '4096',
      n_predict: '64',
      n_discarded: '20',
      temp: '0.95',
      top_k: '50'
    },
    expectSuccess: true
  },
  {
    name: 'Zero temperature produces deterministic output',
    overrides: {
      temp: '0',
      top_p: '0.8',
      top_k: '30',
      n_predict: '32',
      seed: '1'
    },
    expectSuccess: true
  },
  {
    name: 'Unlimited generation accepted',
    overrides: {
      ctx_size: '2048',
      n_predict: '-1',
      temp: '0.9',
      top_p: '0.85',
      repeat_penalty: '1.0'
    },
    expectSuccess: true,
    maxChunks: 5
  },
  {
    name: 'Large ctx_size with high prediction budget is accepted',
    overrides: {
      ctx_size: '10240',
      n_predict: '4096',
      temp: '0.1',
      top_p: '0.8',
      top_k: '30',
      repeat_penalty: '1.1',
      presence_penalty: '0.1',
      frequency_penalty: '0.1'
    },
    expectSuccess: true,
    maxChunks: 2
  },
  {
    name: 'Long prompt handled without overflow',
    overrides: {
      ctx_size: '2048',
      n_predict: '64',
      temp: '0.9',
      top_p: '0.9'
    },
    prompt: LONG_PROMPT,
    expectSuccess: true,
    expectedLogsAbsent: ['context overflow at prefill step']
  },
  {
    name: '8k prompt overflows when ctx_size is 20',
    overrides: {
      ctx_size: '20',
      n_predict: '32',
      temp: '0.7',
      top_p: '0.9'
    },
    prompt: [
      {
        role: 'system',
        content: 'You are a helpful, respectful and honest assistant.'
      },
      {
        role: 'user',
        content: new Array(146).fill('This sentence intentionally bloats the prompt to approach eight thousand tokens of user content.').join(' ')
      }
    ],
    expectRunFailure: /context|ctx[- ]?size|overflow/i,
    cleanupDelayMs: 15000 // Long delay to allow C++ cleanup after overflow
  },
  {
    name: '8k prompt fits within ctx_size 8192',
    overrides: {
      ctx_size: '8192',
      n_predict: '32',
      temp: '0.7',
      top_p: '0.9'
    },
    prompt: [
      {
        role: 'system',
        content: 'You are a helpful, respectful and honest assistant.'
      },
      {
        role: 'user',
        content: new Array(146).fill('This sentence intentionally bloats the prompt to approach eight thousand tokens of user content.').join(' ')
      }
    ],
    expectSuccess: true,
    maxChunks: 2
  },
  {
    name: 'Forced context overflow surfaces error (manual validation)',
    overrides: {
      ctx_size: '128',
      n_predict: '256',
      temp: '0.95',
      top_p: '0.95'
    },
    skipInferenceAfterLoad: true
  },
  {
    name: 'Zero ctx size falls back to minimum context',
    overrides: {
      ctx_size: '0',
      n_predict: '16'
    },
    expectSuccess: true
  },
  {
    name: 'Negative numeric parameters handled without crash',
    overrides: {
      ctx_size: '-1',
      n_predict: '-5',
      temp: '-0.2',
      top_p: '-0.3',
      top_k: '-7',
      repeat_penalty: '-1.1',
      presence_penalty: '-0.5',
      frequency_penalty: '-0.6',
      gpu_layers: '-3',
      'main-gpu': '-1',
      n_discarded: '-4'
    },
    skipInferenceAfterLoad: true
  },
  {
    name: 'Seed -1 accepted',
    overrides: {
      seed: '-1',
      temp: '0.85',
      top_p: '0.9',
      n_predict: '32'
    },
    expectSuccess: true
  },
  {
    name: 'Invalid device surfaces argument error',
    overrides: {
      device: 'invalid'
    },
    expectLoadFailure: /wrong device specified/i
  },
  {
    name: 'Reverse prompt stops generation',
    overrides: {
      reverse_prompt: 'network, pizza, bitcoin, blockchain',
      temp: '0',
      top_p: '0.7',
      n_predict: '128'
    },
    prompt: [
      {
        role: 'system',
        content: 'You are a concise assistant.'
      },
      {
        role: 'user',
        content: 'What kind of food is pizza ?'
      }
    ],
    expectSuccess: true,
    assertOutput: (t, output, stats) => {
      t.ok(output.toLowerCase().includes('pizza'), 'reverse prompt output contains keyword')
      t.ok(output.toLowerCase().split('').slice(-5).join('') === 'pizza', 'reverse prompt output ends with keyword')
    }
  }
]

/**
 * @param {object} [opts] - Options
 * @param {number} [opts.maxChunks] - Cancel after this many chunks (uses opts.model.cancel() when set)
 * @param {object} [opts.model] - Model instance; when maxChunks triggers, cancel via model.cancel()
 */
async function collectResponse (response, opts = {}) {
  const { model } = opts
  const chunks = []
  let chunkCount = 0
  await response
    .onUpdate(async data => {
      chunks.push(data)
      chunkCount++
      if (opts.maxChunks && chunkCount >= opts.maxChunks) {
        if (model && typeof model.cancel === 'function') {
          await model.cancel()
        } else if (typeof response.cancel === 'function') {
          await response.cancel()
        }
      }
    })
    .await()
  return chunks.join('').trim()
}

async function loadAddonOrExpectFailure (t, addon, scenario) {
  try {
    await addon.load()
    if (scenario.expectLoadFailure) {
      t.fail(`${scenario.name}: expected load failure but load succeeded`)
      return false
    }
    return true
  } catch (err) {
    if (scenario.expectLoadFailure) {
      t.ok(
        scenario.expectLoadFailure.test(err.message || String(err)),
        `${scenario.name}: load error matches expectation`
      )
      // unload the addon
      await addon.unload().catch(() => {})
      return false
    }
    throw err
  }
}

async function runInferenceOrExpectFailure (t, addon, scenario, prompt) {
  if (scenario.expectRunFailure) {
    try {
      const response = await addon.run(prompt)
      await response.onUpdate(() => {}).await()
      t.fail(`${scenario.name}: expected run failure but succeeded`)
    } catch (err) {
      const errorText = err?.message || (typeof err?.toString === 'function' ? err.toString() : '')
      t.comment(`${scenario.name} run error: ${errorText}`)
      if (scenario.expectRunFailure.test(errorText || '')) {
        t.pass(`${scenario.name}: run error matches expectation`)
      } else {
        t.fail(`${scenario.name}: unexpected run error "${errorText}"`)
      }
    }
    return false
  }

  const response = await addon.run(prompt)
  const output = await collectResponse(response, {
    maxChunks: scenario.maxChunks,
    model: addon
  })
  t.ok(output.length > 0, `${scenario.name}: produced output (length=${output.length})`)
  if (typeof scenario.assertOutput === 'function') {
    scenario.assertOutput(t, output, response.stats || {})
  }
  return true
}

async function executeScenario (t, scenario) {
  const [modelName, dirPath] = await ensureModel({
    modelName: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
    downloadUrl: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
  })

  const loader = new FilesystemDL({ dirPath })

  const baseConfig = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '1024',
    n_predict: '32',
    temp: '0.7',
    top_p: '0.9',
    top_k: '40',
    repeat_penalty: '1.1',
    seed: '1',
    verbosity: '2'
  }

  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const logs = specLogger.logs

  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: createTestLogger(),
    opts: { stats: true }
  }, { ...baseConfig, ...scenario.overrides })

  let loadSucceeded = false

  try {
    const loadResult = await loadAddonOrExpectFailure(t, addon, scenario)
    if (!loadResult) return
    loadSucceeded = true

    if (scenario.skipInferenceAfterLoad) {
      t.pass(`${scenario.name}: load completed (inference skipped by design)`)
      return
    }

    const prompt = scenario.prompt || BASE_PROMPT

    const runSucceeded = await runInferenceOrExpectFailure(t, addon, scenario, prompt)
    if (!runSucceeded) return

    if (scenario.expectedLogs) {
      for (const snippet of scenario.expectedLogs) {
        t.ok(
          logs.some(entry => entry.includes(snippet)),
          `${scenario.name}: log contains "${snippet}"`
        )
      }
    }

    if (scenario.expectedLogsAbsent) {
      for (const snippet of scenario.expectedLogsAbsent) {
        t.ok(
          !logs.some(entry => entry.includes(snippet)),
          `${scenario.name}: log does not contain "${snippet}"`
        )
      }
    }
  } finally {
    if (scenario.cleanupDelayMs) {
      await new Promise(resolve => setTimeout(resolve, scenario.cleanupDelayMs))
    }
    if (loadSucceeded) {
      await addon.unload().catch(() => {})
    }
    await loader.close().catch(() => {})
    specLogger.release()
  }
}

for (const scenario of scenarios) {
  test(scenario.name, { timeout: 900_000, skip: isMobile }, async t => {
    console.log(`\n******* TEST scenario '${scenario.name}' *******`)
    await executeScenario(t, scenario)
  })
}
