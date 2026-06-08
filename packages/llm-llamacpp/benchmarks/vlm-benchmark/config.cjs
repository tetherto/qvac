'use strict'
// QVAC-19178: single source of truth for the VLM benchmark (config + presets).
//
// Configures BOTH legs (on mobile this file is staged into test/integration by
// stage.cjs):
//   • Linux (desktop) — override the active preset with QVAC_VLM_PRESET / QVAC_VLM_*.
//   • Samsung S25 (AWS Device Farm) — NO env passthrough, so the active preset on-device
//     is `defaultPreset` here. To change what the S25 leg runs, edit `defaultPreset`.
//
// Each GGUF "blob" carries a `source` descriptor (how to fetch the bytes) plus an
// optional `registry` annotation (whether it's a published QVAC-registry entry).
// See resolveBlob() in harness.cjs.
//   source.type 'hf'  : { type:'hf', repo, sha, file } -> pinned HuggingFace
//   source.type 'url' : { type:'url', url }             -> arbitrary direct link
//   source.type 's3'  : { type:'s3', url }              -> S3 (presigned URL)
//   registry: { license, link }                         -> mark as QVAC-registry
//     entry; report Source = "Registry". (bytes still come via source.* — the
//     registry's canonical source is the same pinned URL.)

// Pinned commit SHAs (immutable provenance). Both Qwen3.5-0.8B mmproj quants
// below are published in the QVAC registry (models.prod.json) at these exact
// pinned URLs — the registry's unsloth repo ships F16/BF16, and the mradermacher
// Q8_0 projector was added as a registry entry. So our pinned fetch is
// byte-identical to the registry's canonical `source`.
const SHA = {
  qwenUnsloth: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0', // registry: main + f16 mmproj
  qwenMrader: '9d48fdbc0d8f133716da87ec1d904e5d2c7175a6', //  registry: q8 mmproj
  gemmaBart: 'b5e99bd964eaacc27ba484bb2eb3e9f6160b9143', //   registry: main + f16 mmproj
  gemmaGgml: 'a1dac71d3ab220618f5a7573a52acdc4baf3ae3b' //    candidate q8 mmproj
}

// A `registry` annotation marks a blob as a published QVAC-registry entry. The
// bytes are fetched from the registry's canonical `source` URL (HTTPS, works on
// Linux + S25); the report shows Source = "Registry" for these. The live
// `@qvac/registry-client` (findModels/downloadModel, P2P) is the backup lookup.
const QWEN_REG = { license: 'Apache-2.0', link: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF' }

const MODELS = {
  qwen: {
    main: {
      modelName: 'reg-qwen-unsloth-Q8_0.gguf',
      origin: `unsloth/Qwen3.5-0.8B-GGUF@${SHA.qwenUnsloth.slice(0, 10)}`,
      registry: QWEN_REG,
      source: { type: 'hf', repo: 'unsloth/Qwen3.5-0.8B-GGUF', sha: SHA.qwenUnsloth, file: 'Qwen3.5-0.8B-Q8_0.gguf' }
    },
    mmproj: {
      f16: {
        modelName: 'reg-qwen-unsloth-mmproj-F16.gguf',
        origin: `unsloth/Qwen3.5-0.8B-GGUF@${SHA.qwenUnsloth.slice(0, 10)} · mmproj-F16`,
        registry: QWEN_REG,
        source: { type: 'hf', repo: 'unsloth/Qwen3.5-0.8B-GGUF', sha: SHA.qwenUnsloth, file: 'mmproj-F16.gguf' }
      },
      q8: {
        modelName: 'reg-qwen-mradermacher-mmproj-Q8_0.gguf',
        origin: `mradermacher/Qwen3.5-0.8B-GGUF@${SHA.qwenMrader.slice(0, 10)} · mmproj-Q8_0`,
        registry: { license: 'Apache-2.0', link: 'https://huggingface.co/mradermacher/Qwen3.5-0.8B-GGUF' },
        source: { type: 'hf', repo: 'mradermacher/Qwen3.5-0.8B-GGUF', sha: SHA.qwenMrader, file: 'Qwen3.5-0.8B.mmproj-Q8_0.gguf' }
      }
    },
    ctx_size: '4096'
  },
  gemma: {
    main: {
      modelName: 'reg-gemma-bartowski-Q4_K_M.gguf',
      origin: `bartowski/google_gemma-4-E2B-it-GGUF@${SHA.gemmaBart.slice(0, 10)} (registry main)`,
      source: { type: 'hf', repo: 'bartowski/google_gemma-4-E2B-it-GGUF', sha: SHA.gemmaBart, file: 'google_gemma-4-E2B-it-Q4_K_M.gguf' }
    },
    mmproj: {
      f16: {
        modelName: 'reg-gemma-bartowski-mmproj-f16.gguf',
        origin: `bartowski/google_gemma-4-E2B-it-GGUF@${SHA.gemmaBart.slice(0, 10)} (registry f16)`,
        source: { type: 'hf', repo: 'bartowski/google_gemma-4-E2B-it-GGUF', sha: SHA.gemmaBart, file: 'mmproj-google_gemma-4-E2B-it-f16.gguf' }
      },
      q8: {
        modelName: 'cand-gemma-ggml-mmproj-Q8_0.gguf',
        origin: `ggml-org/gemma-4-E2B-it-GGUF@${SHA.gemmaGgml.slice(0, 10)} (CANDIDATE q8)`,
        source: { type: 'hf', repo: 'ggml-org/gemma-4-E2B-it-GGUF', sha: SHA.gemmaGgml, file: 'mmproj-gemma-4-E2B-it-Q8_0.gguf' }
      }
    },
    ctx_size: '4096'
  }
}

// Open-licensed fixture tasks (regenerate/curate via scripts/build-vlm-fixture.cjs;
// per-image attribution in vlm-fixture.NOTICE.md).
const TASKS = ['textvqa', 'vizwiz', 'gqa', 'docvqa', 'ai2d']

// Every (model · mmproj) cell, used by two-models mode. A preset picks a subset.
const ALL_CELLS = [
  { model: 'qwen', mmproj: 'q8' },
  { model: 'qwen', mmproj: 'f16' },
  { model: 'gemma', mmproj: 'q8' },
  { model: 'gemma', mmproj: 'f16' }
]

module.exports = {
  // ════════════════════════ MODES ════════════════════════
  // The benchmark runs in ONE comparison mode. The workflow's `matrix_mode` input
  // sets it on Linux (env QVAC_VLM_MODE); on the S25 device leg (no env passthrough)
  // the active preset's `mode` / `mode` below decides.
  //
  //   two-models       vary the MODEL blob (base vs candidate mmproj); engine FIXED.
  //                    Cross-platform: Linux CPU/GPU + Samsung S25 CPU/GPU.
  //   several-sources  vary the ENGINE (addon / fabric-cli / upstream-cli); model FIXED.
  //                    Linux only — fabric/upstream are native llama-mtmd-cli binaries.
  mode: 'two-models',

  // ── two-models settings ──
  base: 'f16', //       baseline mmproj label (shown as the "base" column)
  candidate: 'q8', //   candidate mmproj label (the "candidate" column)
  engine: 'addon', //   the fixed engine (addon | fabric-cli | upstream-cli)

  // ── several-sources settings ──
  engines: ['addon', 'fabric-cli', 'upstream-cli'], // engines compared (model fixed below)

  // ════════════════════════ SHARED ════════════════════════
  models: MODELS, //    model catalog (each blob has a source descriptor + registry tag)
  allCells: ALL_CELLS,

  // Active preset for the S25 device leg AND the Linux default. Override on Linux with
  // QVAC_VLM_PRESET. A preset bundles the run settings; per-field env overrides:
  //   QVAC_VLM_SAMPLES→samplesPerTask · QVAC_VLM_REPEATS→repeats
  //   QVAC_VLM_DEVICES→devices (csv) · QVAC_VLM_TASKS→tasks (csv)
  // `null` = harness default (all cells / all fixture tasks / cpu+gpu).
  defaultPreset: 'smoke', // TEMP: minimal on-device check for the folder refactor; revert to 'compare'

  presets: {
    // ── two-models presets ──────────────────────────────────────────────
    // f16 vs q8 mmproj on Qwen3.5, the 5 open-licensed tasks (15 images ≤1024px).
    compare: { mode: 'two-models', cells: [{ model: 'qwen', mmproj: 'f16' }, { model: 'qwen', mmproj: 'q8' }], tasks: TASKS, samplesPerTask: 3, repeats: 3, devices: null },
    // The full matrix (all model·mmproj cells × all tasks).
    full: { mode: 'two-models', cells: ALL_CELLS, tasks: null, samplesPerTask: 5, repeats: 3, devices: null },
    // 1 cell / 1 task / 1 sample — pipeline wiring check.
    smoke: { mode: 'two-models', cells: [{ model: 'qwen', mmproj: 'q8' }], tasks: ['textvqa'], samplesPerTask: 1, repeats: 1, devices: null },

    // ── several-sources preset (Linux only) ─────────────────────────────
    // ONE fixed model (Qwen3.5 + q8 mmproj) across addon + fabric-cli + upstream-cli.
    sources: { mode: 'several-sources', cells: [{ model: 'qwen', mmproj: 'q8' }], engines: ['addon', 'fabric-cli', 'upstream-cli'], tasks: TASKS, samplesPerTask: 3, repeats: 3, devices: null }
  }
}
