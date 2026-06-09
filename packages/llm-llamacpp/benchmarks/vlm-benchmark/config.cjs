'use strict'
// QVAC-19178: single source of truth for the VLM benchmark (models + presets).
//
// ─ What the benchmark compares ─
//   two-models      MODEL_1 vs MODEL_2 — two complete VLMs, one inference engine.
//                   They can be two BLOBS/VARIANTS of the same model (the default:
//                   Qwen3.5-0.8B with the mmproj at F16 vs Q8 — same LLM, different
//                   projector) or two DIFFERENT models (point the two `llm` blobs at
//                   different models). Runs on every target (desktop + mobile, CPU + GPU).
//   several-sources SOURCES_MODEL across several inference engines (addon / fabric-cli
//                   / upstream-cli). Desktop-only — the CLIs are native binaries.
//
// ─ Targets ─ A "target" is a (platform × backend) pair. Platform-agnostic:
//   desktop (Linux by default) and mobile (Samsung Galaxy S25 by default), each on
//   CPU and GPU where applicable. Adding an OS/phone is a workflow/runner change.
//   • desktop reads the active preset from QVAC_VLM_PRESET (per-field QVAC_VLM_*
//     overrides); on mobile there is NO env passthrough, so it always uses
//     `defaultPreset` below.
//
// ─ A "model" ─ a complete VLM: a main LLM blob + a vision-projector (mmproj) blob.
//   Each blob carries a `source` descriptor (how to fetch the bytes) and an optional
//   `registry` annotation (a published QVAC-registry entry; reported as Source =
//   "Registry"). See resolveBlob() in harness.cjs.
//     source.type 'hf'  : { type:'hf', repo, sha, file } -> pinned HuggingFace commit
//     source.type 'url' : { type:'url', url }             -> arbitrary direct link
//     source.type 's3'  : { type:'s3', url }              -> S3 (presigned URL)

// Pinned commit SHAs (immutable provenance).
const SHA = {
  qwenUnsloth: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0', // registry: Qwen3.5 main + f16 mmproj
  qwenMrader: '9d48fdbc0d8f133716da87ec1d904e5d2c7175a6', //  registry: Qwen3.5 q8 mmproj
  gemmaBart: 'b5e99bd964eaacc27ba484bb2eb3e9f6160b9143' //    Gemma main + f16 mmproj
}

// Apache-2.0 Qwen mmproj blobs are published in the QVAC registry; the pinned HF URL
// below is byte-identical to the registry's canonical source.
const QWEN_REG = { license: 'Apache-2.0', link: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF' }

// hf-source blob helper: { modelName (local cache file), origin (human label),
// source (fetch plan), registry? (mark as a registry entry) }.
function hf (modelName, origin, repo, sha, file, registry) {
  return { modelName, origin, registry, source: { type: 'hf', repo, sha, file } }
}

// ════════════════════ THE TWO MODELS UNDER TEST (two-models mode) ════════════════════
// Edit these two to change what two-models compares. The default compares two BLOBS of
// the SAME model — Qwen3.5-0.8B with the mmproj projector at F16 vs Q8 (same main LLM,
// different vision-projector quant). To compare two DIFFERENT models instead, point the
// two `llm` blobs at different models.
const MODEL_1 = {
  label: 'qwen3.5-f16', //    short id — report column + marker key (keep filesystem-safe)
  name: 'Qwen3.5-0.8B · mmproj-F16', // display name
  ctx_size: '4096',
  llm: hf('reg-qwen-unsloth-Q8_0.gguf', `unsloth/Qwen3.5-0.8B-GGUF@${SHA.qwenUnsloth.slice(0, 10)}`,
    'unsloth/Qwen3.5-0.8B-GGUF', SHA.qwenUnsloth, 'Qwen3.5-0.8B-Q8_0.gguf', QWEN_REG),
  mmproj: hf('reg-qwen-unsloth-mmproj-F16.gguf', `unsloth/Qwen3.5-0.8B-GGUF@${SHA.qwenUnsloth.slice(0, 10)} · mmproj-F16`,
    'unsloth/Qwen3.5-0.8B-GGUF', SHA.qwenUnsloth, 'mmproj-F16.gguf', QWEN_REG)
}

const MODEL_2 = {
  label: 'qwen3.5-q8', //     short id
  name: 'Qwen3.5-0.8B · mmproj-Q8', // display name
  ctx_size: '4096',
  llm: hf('reg-qwen-unsloth-Q8_0.gguf', `unsloth/Qwen3.5-0.8B-GGUF@${SHA.qwenUnsloth.slice(0, 10)}`,
    'unsloth/Qwen3.5-0.8B-GGUF', SHA.qwenUnsloth, 'Qwen3.5-0.8B-Q8_0.gguf', QWEN_REG),
  mmproj: hf('reg-qwen-mradermacher-mmproj-Q8_0.gguf', `mradermacher/Qwen3.5-0.8B-GGUF@${SHA.qwenMrader.slice(0, 10)} · mmproj-Q8_0`,
    'mradermacher/Qwen3.5-0.8B-GGUF', SHA.qwenMrader, 'Qwen3.5-0.8B.mmproj-Q8_0.gguf',
    { license: 'Apache-2.0', link: 'https://huggingface.co/mradermacher/Qwen3.5-0.8B-GGUF' })
}

// ════════════════════ THE MODEL FOR SOURCE COMPARISON (several-sources mode) ════════════════════
// One fixed VLM, run through every engine. Its blob filenames must match the names the
// workflow's CLI step feeds to fabric-cli/upstream-cli.
const SOURCES_MODEL = {
  label: 'qwen3.5-0.8b-q8',
  name: 'Qwen3.5-0.8B (mmproj Q8)',
  ctx_size: '4096',
  llm: hf('reg-qwen-unsloth-Q8_0.gguf', `unsloth/Qwen3.5-0.8B-GGUF@${SHA.qwenUnsloth.slice(0, 10)}`,
    'unsloth/Qwen3.5-0.8B-GGUF', SHA.qwenUnsloth, 'Qwen3.5-0.8B-Q8_0.gguf', QWEN_REG),
  mmproj: hf('reg-qwen-mradermacher-mmproj-Q8_0.gguf', `mradermacher/Qwen3.5-0.8B-GGUF@${SHA.qwenMrader.slice(0, 10)} · mmproj-Q8_0`,
    'mradermacher/Qwen3.5-0.8B-GGUF', SHA.qwenMrader, 'Qwen3.5-0.8B.mmproj-Q8_0.gguf',
    { license: 'Apache-2.0', link: 'https://huggingface.co/mradermacher/Qwen3.5-0.8B-GGUF' })
}

// Open-licensed fixture tasks (regenerate/curate via build-fixture.cjs;
// per-image attribution in fixture.NOTICE.md).
const TASKS = ['textvqa', 'vizwiz', 'gqa', 'docvqa', 'ai2d']

module.exports = {
  // ════════════════════════ MODE — what is compared ════════════════════════
  // 'two-models' | 'several-sources'. The workflow's matrix_mode input sets it on
  // desktop (QVAC_VLM_MODE); on mobile this default is used.
  mode: 'two-models',

  // two-models compares these two complete VLMs:
  models: [MODEL_1, MODEL_2],
  // several-sources runs this one VLM across the engines below:
  sourcesModel: SOURCES_MODEL,
  engines: ['addon', 'fabric-cli', 'upstream-cli'],
  engine: 'addon', //         the fixed engine for two-models

  // Report column labels for two-models (derived from the two models above).
  base: MODEL_1.label,
  candidate: MODEL_2.label,

  // ════════════════════════ PRESET — how much is run ════════════════════════
  // A preset is purely the run size (tasks × samples × repeats); it is independent of
  // the mode. Used verbatim on mobile, and the desktop default when QVAC_VLM_PRESET is
  // unset. Per-field desktop env overrides:
  //   QVAC_VLM_SAMPLES→samplesPerTask · QVAC_VLM_REPEATS→repeats
  //   QVAC_VLM_DEVICES→devices (csv) · QVAC_VLM_TASKS→tasks (csv)
  // `devices: null` = CPU + GPU where applicable; `tasks: null` = all fixture tasks.
  defaultPreset: 'base',

  presets: {
    // smoke — 1 task, 1 image, 1 repeat: a single inference per config (wiring check).
    smoke: { tasks: ['textvqa'], samplesPerTask: 1, repeats: 1, devices: null },
    // base — DEFAULT eval: 5 tasks × 3 samples × 1 repeat.
    base: { tasks: TASKS, samplesPerTask: 3, repeats: 1, devices: null },
    // full — 5 tasks × 5 samples × 1 repeat (the complete fixture).
    full: { tasks: TASKS, samplesPerTask: 5, repeats: 1, devices: null }
  }
}
