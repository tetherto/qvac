'use strict'

// Runtime verification for Qwen3.8-Flash-Next (arch `qwen4exp`) on the
// llm-llamacpp addon. QVAC-24312.
//
// Covers the five behaviors the static review could not prove:
//   1. A 3-shard split GGUF plus mmproj loads through the addon path.
//   2. The reasoning channel engages from the model's own chat template
//      (the arch is not in QWEN3_REASONING_FAMILY_ARCHES, so template
//      detection is the only source of thinking tags).
//   3. reasoning_budget: 0 renders the pre-closed think block and the
//      model answers directly.
//   4. Tool calls come out in the Qwen3.5 XML frame
//      (<tool_call><function=...><parameter=...>), which is the evidence
//      for widening the dialect regex in packages/inference.
//   5. Image input works through the qwen3vl_merger projector.
//
// It also scans the addon log for the two markers the reasoning
// deep-dive asked for: the specialized-template selection line, and the
// absence of a "reasoning detection disabled" warning (which would mean
// <think> does not tokenize as a control token in this vocab).
//
// Expects the model files in one directory (default test/model, override
// with QWEN38_MODEL_DIR):
//   Qwen3.8-Flash-Next-UD-IQ1_S-00001-of-00003.gguf
//   Qwen3.8-Flash-Next-UD-IQ1_S-00002-of-00003.gguf
//   Qwen3.8-Flash-Next-UD-IQ1_S-00003-of-00003.gguf
//   mmproj-F16.gguf
// Any quant works if all its shards are present; set QWEN38_QUANT.
//
// Run:  bare scripts/verify-qwen38-flash-next.js

const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const LlmLlamacpp = require('../index.js')

const MODEL_DIR = process.env.QWEN38_MODEL_DIR || path.resolve(__dirname, '../test/model')
const QUANT = process.env.QWEN38_QUANT || 'UD-IQ1_S'
const SHARDS = [1, 2, 3].map((n) =>
  path.join(MODEL_DIR, `Qwen3.8-Flash-Next-${QUANT}-0000${n}-of-00003.gguf`)
)
const MMPROJ = path.join(MODEL_DIR, 'mmproj-F16.gguf')
const IMAGE = path.resolve(__dirname, '../media/elephant.jpg')

for (const f of [...SHARDS, MMPROJ]) {
  if (!fs.existsSync(f)) {
    console.error(`[verify] missing model file: ${f}`)
    process.exit(2)
  }
}

// Buffer every addon log line so the template/reasoning markers can be
// checked after the fact, while still echoing to the console.
const logLines = []
function capture (level) {
  return (...args) => {
    const line = args.map(String).join(' ')
    logLines.push(line)
    console[level](...args)
  }
}
const logger = {
  log: capture('log'),
  info: capture('log'),
  warn: capture('warn'),
  error: capture('error'),
  debug: capture('log')
}

const failures = []
function check (name, ok, detail) {
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

async function collect (response) {
  const chunks = []
  let error = null
  response
    .onUpdate((data) => {
      chunks.push(data)
    })
    .onError((err) => {
      error = err
    })
  await response.await()
  if (error) throw new Error('Inference error: ' + error)
  return { output: chunks.join(''), stats: response.stats || {} }
}

function visibleOf (output) {
  return output.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

async function main () {
  const inference = new LlmLlamacpp({
    // Pass only the first shard: with a single path the addon skips its JS
    // chunk-streaming branch (~15MB/s, and it buffers a second copy of the
    // weights) and hands the path to llama.cpp, which resolves the
    // -0000N-of-0000M siblings in the same directory and reads them directly.
    files: { model: [SHARDS[0]], projectionModel: MMPROJ },
    config: {
      device: 'gpu',
      gpu_layers: '999',
      // The default mmap load thrashes into the macOS memory compressor on a
      // 96GB machine (33GB compressed, load never finishes), and dio reads at
      // ~15MB/s here (no page-cache readahead). mmap+mlock keeps the fast
      // cached reads but pins the pages so the compressor cannot touch them.
      load_mode: 'mmap+mlock',
      ctx_size: '16384',
      n_predict: '2048',
      temp: '0',
      seed: '42',
      verbosity: '2',
      tools: 'true'
    },
    logger,
    opts: { stats: true }
  })

  // --- 1. split-GGUF + mmproj load ---
  const t0 = Date.now()
  await inference.load()
  check('load: 3-shard split GGUF + mmproj', true, `${((Date.now() - t0) / 1000).toFixed(0)}s`)

  // --- 2. thinking-enabled completion ---
  {
    const { output, stats } = await collect(
      await inference.run([
        { role: 'user', content: 'What is 7 + 5? Reply with the number only.' }
      ])
    )
    const visible = visibleOf(output)
    check(
      'reasoning: template-derived <think> channel closes',
      /<\/think>/.test(output),
      `raw starts: "${output.slice(0, 60).replace(/\n/g, '\\n')}"`
    )
    check(
      'reasoning: correct visible answer after think block',
      /\b12\b/.test(visible),
      `visible: "${visible.slice(0, 80)}" tps=${stats.TPS ? Number(stats.TPS).toFixed(1) : '?'}`
    )
  }

  // --- 3. reasoning_budget: 0 (thinking disabled) ---
  {
    const { output } = await collect(
      await inference.run(
        [{ role: 'user', content: 'What is the capital of France? One word only.' }],
        { generationParams: { reasoning_budget: 0 } }
      )
    )
    const visible = visibleOf(output)
    check(
      'reasoning_budget 0: direct answer',
      /paris/i.test(visible),
      `visible: "${visible.slice(0, 80)}"`
    )
  }

  // --- 4. tool call emits the Qwen3.5 XML frame ---
  {
    const { output } = await collect(
      await inference.run(
        [
          {
            role: 'system',
            content: 'You are a helpful assistant that uses tools when appropriate.'
          },
          {
            type: 'function',
            name: 'get_weather',
            description: 'Get the current weather for a city',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string', description: 'Name of the city' },
                unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
              },
              required: ['city']
            }
          },
          { role: 'user', content: 'What is the weather in Paris in celsius?' }
        ],
        { generationParams: { reasoning_budget: 0 } }
      )
    )
    const hasFrame = output.includes('<tool_call>') && output.includes('<function=get_weather>')
    check(
      'tools: Qwen3.5 XML frame (<tool_call><function=...>)',
      hasFrame,
      `raw: "${output.slice(0, 200).replace(/\n/g, '\\n')}"`
    )
  }

  // --- 5. image through the qwen3vl_merger projector ---
  {
    const imageBytes = new Uint8Array(fs.readFileSync(IMAGE))
    const { output } = await collect(
      await inference.run(
        [
          { role: 'user', type: 'media', content: imageBytes },
          { role: 'user', content: 'What animal is in this image? One word only.' }
        ],
        { generationParams: { reasoning_budget: 0 } }
      )
    )
    const visible = visibleOf(output)
    check('vision: identifies the image subject', /elephant/i.test(visible), `visible: "${visible.slice(0, 80)}"`)
  }

  // --- 6. multi-turn coherence (hybrid SSM state across replayed turns) ---
  {
    const conversation = []
    const chain = [
      { prompt: 'What is 7 + 5? Reply with the number only.', expected: '12' },
      { prompt: 'Multiply that by 2. Reply with the number only.', expected: '24' },
      { prompt: 'Subtract 4 from the result. Reply with the number only.', expected: '20' }
    ]
    let allCorrect = true
    for (const { prompt, expected } of chain) {
      conversation.push({ role: 'user', content: prompt })
      const { output } = await collect(await inference.run(conversation))
      conversation.push({ role: 'assistant', content: output })
      const visible = visibleOf(output)
      const correct = /<\/think>/.test(output) && new RegExp(`\\b${expected}\\b`).test(visible)
      console.log(`  turn: expected=${expected} visible="${visible.slice(0, 60)}" correct=${correct}`)
      if (!correct) allCorrect = false
    }
    check('multi-turn: 3-step arithmetic chain', allCorrect)
  }

  await inference.unload()

  // --- log markers from the reasoning deep-dive ---
  const joined = logLines.join('\n')
  const detectionDisabled = /reasoning detection disabled|reasoning.*disabled/i.test(joined)
  check(
    'log: no "reasoning detection disabled" warning',
    !detectionDisabled,
    detectionDisabled ? 'the <think> tag may not tokenize as a control token in this vocab' : ''
  )
  const templateLine = logLines.find((l) => /specialized template|chat format/i.test(l))
  console.log(`\n[info] template selection log line: ${templateLine || '(none captured)'}`)

  console.log('\n=== Verdict ===')
  if (failures.length === 0) {
    console.log('[PASS] Qwen3.8-Flash-Next works end to end on this addon build.')
    process.exit(0)
  }
  console.error(`[FAIL] ${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}

main().catch((err) => {
  console.error('[verify] fatal:', err)
  process.exit(3)
})
