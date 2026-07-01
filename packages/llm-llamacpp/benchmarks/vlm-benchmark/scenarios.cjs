'use strict'
// The task set the benchmark runs.
//
// A SINGLE descriptive set — the five lmms-eval VQA tasks plus the OCR tasks — scored
// per task. There is NO quality-regression gate: the benchmark compares DIFFERENT
// models (and one model across inference sources), so a candidate-vs-baseline accuracy
// gate doesn't apply; quality is reported, not gated.
//
// Each fixture item carries its own `metric`, so a single set mixes families freely:
//   vqa / anls / relaxed / mc  → the higher-better "%" tables
//   ocr                        → CER / WER / BLEU, shown in a SEPARATE table (aggregate.js)
//
// OCR fixture items (tasks `ocr-small`, `ocr-page`) are HAND-CURATED into
// fixture.data.cjs from S3-hosted images — see fixture/README.md for the item shape and
// the "read the text" prompt convention. Until those items exist, the OCR task ids here
// simply select zero items (the VQA suite runs unaffected).
//
// The `scenario` axis is kept (one entry) to avoid churn in the shared harness/workflow;
// it can be fully retired later.

module.exports = {
  default: {
    title: 'VLM quality suite (VQA + OCR)',
    tasks: ['textvqa', 'vizwiz', 'gqa', 'docvqa', 'ai2d', 'ocr-small', 'ocr-page']
  }
}
