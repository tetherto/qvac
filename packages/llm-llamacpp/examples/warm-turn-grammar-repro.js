'use strict'

// Verification for addon-owned full-prompt cache reconciliation.
//
// Every cached request sends the complete conversation and tool definitions.
// The addon renders that authoritative input once, rebuilds the grammar from
// the same render, reuses the longest matching KV prefix, and decodes only the
// new suffix. Resending tools therefore arms the warm-turn grammar without
// appending a duplicate tool block.
//
//   MODEL=/path/to/Qwen3-1.7B-Q4_0.gguf bare warm-turn-grammar-repro.js
//   VERBOSITY=3 shows the addon's own "tokenizeChat ... nTools=N" lines.

const LlmLlamacpp = require('@qvac/llm-llamacpp')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const MODEL =
  os.getEnv('MODEL') ||
  path.join(os.homedir(), '.qvac/models/f7cce66406dee646_Qwen3-1.7B-Q4_0.gguf')
const VERBOSITY = os.getEnv('VERBOSITY') || '1'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grammar-repro-'))
const cache = path.join(dir, 'session.bin')

const tools = [
  {
    type: 'function',
    name: 'set_thermostat',
    description: 'Set the target temperature of a room thermostat.',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room name' },
        temperature: { type: 'integer', description: 'Target in whole degrees Celsius' },
        mode: { type: 'string', enum: ['heat', 'cool'] }
      },
      required: ['room', 'temperature', 'mode']
    }
  }
]

const system = {
  role: 'system',
  content: 'You are a home assistant. Use the thermostat tool for every temperature request.'
}
const turn1 = { role: 'user', content: 'Set the living room to 21 degrees, heating.' }
const turn2 = { role: 'user', content: 'Now set the bedroom to 18.5 degrees, cooling.' }

// The Qwen3 template opens <think> by default; a zero budget keeps the output
// to the call itself so the comparison below is about the tool block only.
const noThinking = { reasoning_budget: 0 }

async function run(model, prompt, opts) {
  const chunks = []
  const response = await model.run(prompt, opts)
  await response.onUpdate((data) => chunks.push(data)).await()
  return { text: chunks.join('').trim(), stats: response.stats }
}

function row(label, r) {
  const s = r.stats
  console.log(
    `${label.padEnd(34)} promptTokens=${s.promptTokens}  cacheTokens=${s.CacheTokens}  toolDefinitionsDropped=${s.toolDefinitionsDropped}`
  )
  console.log(`  model said: ${r.text.replace(/\s+/g, ' ').slice(0, 180)}`)
}

async function main() {
  const model = new LlmLlamacpp({
    files: { model: [MODEL] },
    config: {
      device: 'gpu',
      gpu_layers: '999',
      ctx_size: '4096',
      temp: '0.1',
      n_predict: '256',
      verbosity: VERBOSITY,
      tools: 'true'
    },
    logger: null,
    opts: { stats: true }
  })
  await model.load()

  try {
    const firstHistory = [system, ...tools, turn1]
    console.log('\n== Turn 1 (cold): complete history and tools')
    const t1 = await run(model, firstHistory, {
      cacheKey: cache,
      saveCacheToDisk: true,
      generationParams: noThinking
    })
    row('turn 1: tools sent', t1)

    const fullHistory = [
      ...firstHistory,
      { role: 'assistant', content: t1.text },
      { role: 'tool', content: '{"ok":true}' },
      turn2
    ]

    console.log('\n== Turn 2 (warm): complete history and tools, grammar auto')
    const t2 = await run(model, fullHistory, {
      cacheKey: cache,
      generationParams: { ...noThinking, tool_choice: 'auto' }
    })
    row('turn 2: tools resent, auto', t2)

    if (t2.stats.toolDefinitionsDropped !== 0) {
      throw new Error('warm turn dropped the tool definitions')
    }
    if (!t2.text.includes('<tool_call>')) {
      throw new Error('auto warm turn did not generate a tool call')
    }
    if (t2.stats.promptTokens >= t1.stats.promptTokens) {
      throw new Error(
        `warm turn decoded ${t2.stats.promptTokens} prompt tokens; expected fewer than cold turn ${t1.stats.promptTokens}`
      )
    }

    console.log(
      `\nwarm turn decoded ${t2.stats.promptTokens} prompt tokens vs ${t1.stats.promptTokens} cold -> cached tool block reused, grammar armed`
    )
  } finally {
    await model.unload()
  }
}

main().catch((err) => {
  console.error('repro failed:', err && err.stack ? err.stack : err)
  Bare.exit(1)
})
