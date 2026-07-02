'use strict'
// Offline metric-tuning harness. Re-scores REAL model
// predictions with the current scorers so the quality metrics (VQA % and the OCR
// CER/WER/BLEU) can be tuned WITHOUT re-running inference. Run: node score-check.cjs
//
// Golds are read live from fixture.data.cjs (so they stay in sync with curation);
// only the predictions are embedded — captured from a local Qwen3.5-0.8B run
// (llama-server, reasoning off, GPU). Replace/extend PRED with predictions from any
// run you want to tune against.
const { score, ocrScore, OCR_METRICS } = require('./aggregate.js')
const fixture = require('./fixture.data.cjs')

// Real predictions captured per fixture item id (a few per task).
const PRED = {
  textvqa_0: 'Philippe Molitor',
  textvqa_1: '2010',
  textvqa_2: '50',
  vizwiz_0: 'no',
  vizwiz_1: '1989',
  vizwiz_2: 'yes',
  gqa_0: 'woman',
  gqa_1: 'chalkboard',
  gqa_2: 'no',
  docvqa_0: 'TO',
  docvqa_1: 'NAME',
  docvqa_2: '10',
  ai2d_0: 'C',
  ai2d_1: 'A',
  ai2d_2: 'A',
  'ocr-small_0': 'A bad workman always blames his tools.',
  'ocr-small_1': 'HONESTY IS THE BEST POLICY.',
  'ocr-small_2': 'What is done cannot be undone',
  'ocr-page_0': 'Ezequiel Kilback\n93293 Cedar Road\nJedediahport, Kansas 01204-1201\n\nWells Fargo\n\nPAY TO THE ORDER OF\nWilderman and Sons',
  'ocr-page_2': '| Attributes | P (%) | R (%) | F1 (%) |\n|---|---|---|---|\n| Frame Color | 63.16 | 48.00 | 54.55 |\n| Lenses Color | 64.29'
}
const byId = Object.fromEntries(fixture.items.map(it => [it.id, it]))

// ── VQA-family tasks: graded % per item, mean per task ─────────────────────
const pct = x => (100 * x).toFixed(1).padStart(6)
const tasks = {}
for (const id of Object.keys(PRED)) {
  const it = byId[id]; if (!it || OCR_METRICS.has(it.metric)) continue
  ;(tasks[it.task] = tasks[it.task] || { metric: it.metric, s: [] }).s.push(score(it.metric, PRED[id], it.gold))
}
console.log('VQA quality (graded % — higher better)')
console.log('task     metric  per-item                 mean %')
console.log('-----------------------------------------------------')
let sum = 0; let n = 0
for (const [task, { metric, s }] of Object.entries(tasks)) {
  const mean = s.reduce((a, b) => a + b, 0) / s.length; sum += mean; n++
  console.log(`${task.padEnd(8)} ${metric.padEnd(6)} [${s.map(x => x.toFixed(2)).join(', ')}]   ${pct(mean)}`)
}
console.log(`Overall %% (equal-weight mean across VQA tasks):    ${pct(sum / n)}`)

// ── OCR tasks: CER / WER ↓ lower better · BLEU ↑ higher better ─────────────
console.log('\nOCR quality (CER ↓ / WER ↓ · BLEU ↑)')
console.log('item            CER     WER    BLEU')
console.log('-----------------------------------------------------')
for (const id of Object.keys(PRED)) {
  const it = byId[id]; if (!it || !OCR_METRICS.has(it.metric)) continue
  const o = ocrScore(PRED[id], it.gold)
  console.log(`${id.padEnd(14)} ${o.cer.toFixed(3)}  ${o.wer.toFixed(3)}  ${o.bleu.toFixed(3)}`)
}
