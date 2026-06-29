'use strict'
// Single source of truth for the VLM benchmark (models + presets).
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
//   desktop (Linux / macOS / Windows) and mobile (Device Farm phones), each on
//   CPU and GPU where applicable. Adding an OS/phone is a workflow/runner change.
//   • every target reads the active run from QVAC_VLM_PRESET / QVAC_VLM_* env —
//     the workflow sets it directly on desktop and forwards it to phones via the
//     pushed device config; `defaultPreset` below is the no-env fallback.
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
  gemmaBart: 'b5e99bd964eaacc27ba484bb2eb3e9f6160b9143', //   registry: Gemma-4-E2B q4 main (+ f16/bf16 mmproj)
  gemmaGgml: 'a1dac71d3ab220618f5a7573a52acdc4baf3ae3b' //    registry: Gemma-4-E2B q8 mmproj
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

// Gemma-4-E2B: Q4_K_M main + Q8_0 mmproj — both QVAC-registry-published
// (registry-server data/models.prod.json); the pinned HF URLs below are the
// registry entries' canonical sources (byte-identical, work on every target —
// the mobile app has no P2P registry client).
const GEMMA4_Q4 = {
  label: 'gemma4-q4',
  name: 'Gemma-4-E2B-it · Q4_K_M + mmproj-Q8',
  ctx_size: '4096',
  llm: hf('reg-gemma4-e2b-Q4_K_M.gguf', `bartowski/google_gemma-4-E2B-it-GGUF@${SHA.gemmaBart.slice(0, 10)}`,
    'bartowski/google_gemma-4-E2B-it-GGUF', SHA.gemmaBart, 'google_gemma-4-E2B-it-Q4_K_M.gguf',
    { license: 'Gemma', link: 'https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF' }),
  mmproj: hf('reg-gemma4-e2b-mmproj-Q8_0.gguf', `ggml-org/gemma-4-E2B-it-GGUF@${SHA.gemmaGgml.slice(0, 10)} · mmproj-Q8_0`,
    'ggml-org/gemma-4-E2B-it-GGUF', SHA.gemmaGgml, 'mmproj-gemma-4-E2B-it-Q8_0.gguf',
    { license: 'Gemma', link: 'https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF' })
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

// Scenario definitions (the workload axis — which fixture tasks run, how they
// are scored) live in their own file (scenarios.cjs). The task lists live there too.
const SCENARIOS = require('./scenarios.cjs')

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

  // ════════════════════════ MODEL CATALOG — known-good short names ════════════════════════
  // Convenience only — the matrix_models launch param also accepts ad-hoc
  // <llm-url>|<mmproj-url> pairs for ANY model with no catalog entry (see
  // CONTRACT.md §3 and models.cjs). Add entries for regulars; a catalog entry
  // may carry a per-model `baseline` override for the gate.
  catalog: {
    'qwen3.5-f16': MODEL_1,
    'qwen3.5-q8': MODEL_2,
    'qwen3.5-0.8b-q8': SOURCES_MODEL,
    'gemma4-q4': GEMMA4_Q4
  },
  // What runs when matrix_models is empty (two-models mode).
  defaultModels: ['qwen3.5-f16', 'qwen3.5-q8'],

  // ════════════════════════ SOURCES — builds under comparison ════════════════════════
  // Tokens for the matrix_sources launch param (parsed by sources.cjs).
  // addon@candidate is built from the dispatched ref; addon@baseline is the pinned
  // published npm version; fabric/upstream run via the several-sources CLI path
  // (desktop only — built per-OS on Linux/macOS/Windows).
  sources: {
    'addon@candidate': { type: 'addon', ref: 'branch' },
    'addon@baseline': { type: 'addon', ref: 'npm' },
    fabric: { type: 'fabric-cli', ref: 'v8189.0.2' },
    upstream: { type: 'upstream-cli', ref: 'b8189' }
  },
  // Offline FALLBACK for addon@baseline only. The benchmark workflow auto-detects the
  // latest published @qvac/llm-llamacpp release at run time (or honours the `baseline_npm`
  // dispatch input); this pin is used solely if that registry lookup fails.
  defaultBaseline: { npm: '0.24.0' },

  // ════════════════════════ SCENARIOS — the task set ════════════════════════
  // One descriptive set (5 VQA tasks + OCR), scored per task; see scenarios.cjs.
  scenarios: SCENARIOS,
  defaultScenario: 'default',

  // ════════════════════════ METHODOLOGY — how rounds run ════════════════════════
  // warmup + measured blocks per source, median reported, blocks interleaved
  // across sources, stability guard between blocks ('auto': temperature sensor
  // on macmini, timing-probe elsewhere). Consumed by methodology.cjs.
  methodology: { warmupBlocks: 1, measuredBlocks: 3, statistic: 'median', interleave: true, stability: 'auto' },

  // ════════════════════════ PRESET — which tasks run ════════════════════════
  // A preset selects a TASK GROUP (and the run size). The fallback on every target
  // when QVAC_VLM_PRESET is unset (the workflow sets it everywhere, incl. phones via
  // the pushed device config). Per-field env overrides:
  //   QVAC_VLM_SAMPLES→samplesPerTask · QVAC_VLM_REPEATS→repeats
  //   QVAC_VLM_DEVICES→devices (csv) · QVAC_VLM_TASKS→tasks (csv)
  // `devices: null` = CPU + GPU where applicable; `tasks: null` = all fixture tasks.
  defaultPreset: 'full',

  // Mobile (AWS Device Farm) per-leg timeout in MINUTES — the in-repo default the CI
  // workflow reads when its `mobile_timeout_min` input is empty. Raises the WDIO/Mocha
  // per-test ceiling + the Android generated-spec per-test ceiling so a heavier preset
  // can finish on-device (capped by the 120-min Device-Farm / GitHub job ceilings).
  // null = use the shared pipeline default (35-min Mocha / 30-min Android per-test);
  // the workflow input, when set, overrides this.
  mobileTimeoutMin: null,

  // The two task groups (cognitive = VQA reasoning, ocr = text recognition). Kept here
  // so a preset can run one group in isolation (e.g. for the mobile session budget).
  // `ids` = an explicit fixture-item allowlist (overrides tasks/samples — used to pick
  // specific images). `taskSamples` = per-task overrides of samplesPerTask (first-N).
  presets: {
    // smoke — first task only, 1 image: a single inference per config (wiring check).
    smoke: { tasks: null, maxTasks: 1, samplesPerTask: 1, repeats: 1, devices: null },
    // cognitive — the 5 VQA reasoning tasks × 5 samples.
    cognitive: { tasks: ['textvqa', 'vizwiz', 'gqa', 'docvqa', 'ai2d'], samplesPerTask: 5, repeats: 1, devices: null },
    // ocr1page — a single light document-OCR check: just ocr-page_0 (fits the mobile session).
    ocr1page: { ids: ['ocr-page_0'], samplesPerTask: 5, repeats: 1, devices: null },
    // ocr5pages — the full high-MP document-OCR set: all 5 ocr-page docs (desktop-oriented;
    // overruns the mobile Device-Farm session window).
    ocr5pages: { ids: ['ocr-page_0', 'ocr-page_1', 'ocr-page_2', 'ocr-page_3', 'ocr-page_4'], samplesPerTask: 5, repeats: 1, devices: null },
    // full — cognitive + ocr-small + the one light ocr-page (ocr-page capped to its first
    // sample = ocr-page_0); the heavy ocr5pages docs are excluded.
    full: { tasks: null, samplesPerTask: 5, taskSamples: { 'ocr-page': 1 }, repeats: 1, devices: null }
  }
}
