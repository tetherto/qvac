'use strict'
// Run the VLM matrix fixture through a native llama-mtmd-cli binary
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
// Per-task sample caps (mirror the addon preset's taskSamples, e.g. {"ocr-page":1});
// falls back to the global --samples. Keeps the CLI legs item-aligned with the addon.
const TASK_SAMPLES = JSON.parse(arg('task-samples', '{}') || '{}')
// Per-task decode budget — OCR transcriptions need far more tokens than VQA answers,
// matching harness.cjs so CLI OCR output isn't truncated (which would wreck CER/WER).
const TASK_NPREDICT = { 'ocr-page': 768, 'ocr-small': 96 }
const DEFAULT_NPREDICT = 128
// Cap on the number of DISTINCT tasks (mirror the addon preset's maxTasks, e.g. smoke=1);
// 0 = no cap. Without this the CLI ran every --tasks entry while the addon honoured
// maxTasks, so smoke produced mismatched rows ('—' for tasks the addon skipped).
const MAX_TASKS = parseInt(arg('max-tasks', '0'), 10) || 0
// Explicit item allowlist — mirrors the addon preset's `ids` (e.g. ocr1page=['ocr-page_0'],
// ocr5pages=the 5 ocr-page docs). When set it WINS over tasks/max-tasks, exactly like
// harness.cjs. Without it the CLI ran every task while the addon ran only the listed ids,
// so an id-based preset (ocr1page/ocr5pages) had the addon doing OCR-only and the CLIs
// doing everything → lopsided '—' columns.
const IDS = (arg('ids', '') || '').split(',').map(s => s.trim()).filter(Boolean)
const MAIN_ORIGIN = arg('main-origin', 'Qwen3.5-0.8B-Q8_0')
const MMPROJ_ORIGIN = arg('mmproj-origin', 'Qwen3.5-0.8B mmproj-Q8_0')

if (!BINARY || !fs.existsSync(BINARY)) { console.error(`[cli-fixture] binary not found: ${BINARY}`); process.exit(2) }
if (!LLM || !MMPROJ) { console.error('[cli-fixture] --llm and --mmproj are required'); process.exit(2) }

function selectedItems () {
  // Id allowlist wins (same precedence as harness.cjs selectedItems).
  if (IDS.length) { const want = new Set(IDS); return fixture.items.filter(it => want.has(it.id)) }
  const seen = {}
  return fixture.items.filter(it => {
    if (TASKS.length && !TASKS.includes(it.task)) return false
    if (!(it.task in seen) && MAX_TASKS && Object.keys(seen).length >= MAX_TASKS) return false
    seen[it.task] = (seen[it.task] || 0) + 1
    const cap = (TASK_SAMPLES[it.task] != null) ? TASK_SAMPLES[it.task] : SAMPLES
    return seen[it.task] <= cap
  })
}

const mediaPath = (image) => path.resolve(__dirname, 'fixture', image)

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
      nPredict: TASK_NPREDICT[item.task] || DEFAULT_NPREDICT,
      backend: BACKEND,
      temperature: 0,
      seed: 42,
      thinkingEnabled: false, // match the addon harness (reasoning-budget=0)
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
