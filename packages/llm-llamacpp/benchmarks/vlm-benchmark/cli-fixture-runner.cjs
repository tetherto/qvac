'use strict'
// QVAC-19178: run the VLM matrix fixture through a native llama-mtmd-cli binary
// (fabric-cli / upstream-cli) for several-sources mode. Emits the SAME markers as the
// addon harness (harness.cjs) so the existing aggregate.js scores quality
// (vqa/anls/relaxed/mc) and reads vision-encode the same way:
//   [VLMSEG]{cell:<source>,...}  then the CLI's stderr (carries `image ... encoded in N ms`)
//   [VLMROW]{cell:<source>, source, model, mmproj, device, task, id, metric, gold, pred, ...}
//
// Reuses the exact CLI invocation/template logic from the vendored cli-case-runner.js.
// Linux/desktop only (native binary). Usage:
//   node cli-fixture-runner.cjs --binary <llama-mtmd-cli> --source fabric-cli \
//     --llm <gguf> --mmproj <gguf> --backend cpu|gpu [--tasks t1,t2] [--samples 3] \
//     [--main-origin "..."] [--mmproj-origin "..."]

const fs = require('fs')
const path = require('path')
const { runOnceCli } = require('./cli-case-runner')
const { parseStdoutMetrics } = require('./stdout-parser')
const fixture = require('./fixture.data.cjs')

function arg (name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def }
const BINARY = arg('binary')
const SOURCE = arg('source', 'cli')
const LLM = arg('llm')
const MMPROJ = arg('mmproj')
const BACKEND = arg('backend', 'cpu')
const SAMPLES = parseInt(arg('samples', '3'), 10)
const REPEATS = parseInt(arg('repeats', '3'), 10)
const TASKS = (arg('tasks', '') || '').split(',').map(s => s.trim()).filter(Boolean)
const MAIN_ORIGIN = arg('main-origin', 'Qwen3.5-0.8B-Q8_0')
const MMPROJ_ORIGIN = arg('mmproj-origin', 'Qwen3.5-0.8B mmproj-Q8_0')

if (!BINARY || !fs.existsSync(BINARY)) { console.error(`[cli-fixture] binary not found: ${BINARY}`); process.exit(2) }
if (!LLM || !MMPROJ) { console.error('[cli-fixture] --llm and --mmproj are required'); process.exit(2) }

function selectedItems () {
  const seen = {}
  return fixture.items.filter(it => {
    if (TASKS.length && !TASKS.includes(it.task)) return false
    seen[it.task] = (seen[it.task] || 0) + 1
    return seen[it.task] <= SAMPLES
  })
}

const mediaPath = (image) => path.resolve(__dirname, 'images', image)

function main () {
  // Same provenance shape the addon harness emits, keyed by the source label.
  console.error('[VLMMETA]' + JSON.stringify({
    cell: SOURCE,
    source: SOURCE,
    model: 'qwen',
    mmproj: 'q8',
    main_origin: MAIN_ORIGIN,
    main_source: 'Registry',
    mmproj_origin: MMPROJ_ORIGIN,
    mmproj_source: 'Registry'
  }) + '[/VLMMETA]')

  const items = selectedItems()
  let ok = 0
  for (const item of items) {
    const spec = {
      cliBinaryPath: BINARY,
      llmPath: LLM,
      mmprojPath: MMPROJ,
      imagePath: mediaPath(item.image),
      prompt: item.prompt,
      ctxSize: 4096,
      nPredict: 128,
      backend: BACKEND,
      temperature: 0,
      seed: 42,
      thinkingEnabled: false, // match the addon harness (reasoning-budget=0)
      verbosePrompt: true, // print the rendered prompt for prompt-parity audits
      perRunTimeoutMs: 5 * 60 * 1000
    }
    for (let rep = 0; rep < REPEATS; rep++) {
      console.error('[VLMSEG]' + JSON.stringify({ cell: SOURCE, source: SOURCE, model: 'qwen', mmproj: 'q8', device: BACKEND, id: item.id, rep }) + '[/VLMSEG]')
      try {
        const r = runOnceCli(spec)
        if (r.stderr) process.stderr.write(r.stderr + '\n') // surfaces `image ... encoded in N ms` after the [VLMSEG]
        const m = parseStdoutMetrics(r.stderr || '')
        const ttft = (m.visionEncodeMs != null || m.promptEvalMs != null)
          ? (m.visionEncodeMs || 0) + (m.promptEvalMs || 0)
          : null
        console.log('[VLMROW]' + JSON.stringify({
          cell: SOURCE,
          source: SOURCE,
          model: 'qwen',
          mmproj: 'q8',
          device: BACKEND,
          rep,
          task: item.task,
          id: item.id,
          metric: item.metric,
          gold: item.gold,
          pred: String(r.text).slice(0, 600),
          img: item.image,
          img_w: item.width || null,
          img_h: item.height || null,
          ms: r.wallMs,
          decode_tps: m.decodeTps != null ? m.decodeTps : null,
          ttft_ms: ttft,
          gen_tokens: m.decodeTokens != null ? m.decodeTokens : null,
          prompt_tokens: m.promptTokens != null ? m.promptTokens : null
        }) + '[/VLMROW]')
        ok++
      } catch (e) {
        console.log('[VLMROW]' + JSON.stringify({
          cell: SOURCE,
          source: SOURCE,
          model: 'qwen',
          mmproj: 'q8',
          device: BACKEND,
          rep,
          task: item.task,
          id: item.id,
          metric: item.metric,
          gold: item.gold,
          error: String((e && e.message) || e)
        }) + '[/VLMROW]')
      }
    }
  }
  console.error(`[cli-fixture] ${SOURCE}/${BACKEND}: ${ok}/${items.length} ok`)
}

main()
