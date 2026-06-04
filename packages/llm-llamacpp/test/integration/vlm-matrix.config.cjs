'use strict'
// QVAC-19178: single source of truth for the VLM matrix benchmark.
//
// This file is bundled under test/ so it configures BOTH legs:
//   • Linux (desktop integration path) — can override the active preset with
//     QVAC_VLM_PRESET / QVAC_VLM_* env vars.
//   • Samsung S25 (AWS Device Farm) — has NO generic env passthrough, so the
//     active preset on-device is `defaultPreset` here. To change what the S25
//     leg runs, edit `defaultPreset` (or a preset's cells/tasks/samples).
//
// Each GGUF "blob" carries a `source` descriptor so the same cell can be fed
// from the QVAC registry, a HuggingFace pin, an S3 object, or any URL. See
// resolveBlob() in _vlm-matrix-common.js for how a descriptor becomes a file.
//   hf:       { type: 'hf', repo, sha, file }   -> pinned HuggingFace download
//   url:      { type: 'url', url }               -> arbitrary direct link
//   s3:       { type: 's3', url }                -> S3 (use a presigned URL)
//   registry: { type: 'registry', path, source } -> QVAC registry (P2P client)

// Pinned commit SHAs (immutable provenance). f16 = the mmproj already in the
// QVAC registry; q8 = the candidate projector under evaluation.
const SHA = {
  qwenUnsloth: '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0', // registry main + f16 mmproj
  qwenMrader: '9d48fdbc0d8f133716da87ec1d904e5d2c7175a6', //  candidate q8 mmproj
  gemmaBart: 'b5e99bd964eaacc27ba484bb2eb3e9f6160b9143', //   registry main + f16 mmproj
  gemmaGgml: 'a1dac71d3ab220618f5a7573a52acdc4baf3ae3b' //    candidate q8 mmproj
}

const MODELS = {
  qwen: {
    main: {
      modelName: 'reg-qwen-unsloth-Q8_0.gguf',
      origin: `unsloth/Qwen3.5-0.8B-GGUF@${SHA.qwenUnsloth.slice(0, 10)} (registry main)`,
      source: { type: 'hf', repo: 'unsloth/Qwen3.5-0.8B-GGUF', sha: SHA.qwenUnsloth, file: 'Qwen3.5-0.8B-Q8_0.gguf' }
    },
    mmproj: {
      f16: {
        modelName: 'reg-qwen-unsloth-mmproj-F16.gguf',
        origin: `unsloth/Qwen3.5-0.8B-GGUF@${SHA.qwenUnsloth.slice(0, 10)} (registry f16)`,
        source: { type: 'hf', repo: 'unsloth/Qwen3.5-0.8B-GGUF', sha: SHA.qwenUnsloth, file: 'mmproj-F16.gguf' }
      },
      q8: {
        modelName: 'cand-qwen-mradermacher-mmproj-Q8_0.gguf',
        origin: `mradermacher/Qwen3.5-0.8B-GGUF@${SHA.qwenMrader.slice(0, 10)} (CANDIDATE q8)`,
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

// Every (model · mmproj) cell available in `blobs` mode. A preset picks a subset.
const ALL_CELLS = [
  { model: 'qwen', mmproj: 'q8' },
  { model: 'qwen', mmproj: 'f16' },
  { model: 'gemma', mmproj: 'q8' },
  { model: 'gemma', mmproj: 'f16' }
]

module.exports = {
  models: MODELS,
  allCells: ALL_CELLS,

  // mode: 'blobs'   — vary (model · mmproj) on the @qvac/llm-llamacpp addon.
  //                   This is the mode that runs on BOTH Linux and S25.
  //        'sources' — compare several inference engines (addon vs fabric-cli vs
  //                   upstream-cli) on one model. Desktop-only; lives in
  //                   benchmarks/vlm-performance (run-vlm-bench.js), not here.
  mode: 'blobs',

  // Active preset for the device leg (and the Linux default). Override on Linux
  // with QVAC_VLM_PRESET. Set to 'smoke' for a 1-cell/1-task/1-sample pipeline
  // check; 'full' for the real test set.
  defaultPreset: 'smoke',

  // A preset narrows the matrix. `null` fields fall back to the harness defaults
  // (all cells / all fixture tasks / samples=isMobile?2:5 / devices=cpu+gpu).
  presets: {
    full: { cells: ALL_CELLS, tasks: null, samplesPerTask: null, devices: null },
    smoke: { cells: [{ model: 'qwen', mmproj: 'q8' }], tasks: ['vqav2'], samplesPerTask: 1, devices: null }
  }
}
