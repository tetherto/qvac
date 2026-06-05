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
// Each GGUF "blob" carries a `source` descriptor (how to fetch the bytes) plus an
// optional `registry` annotation (whether it's a published QVAC-registry entry).
// See resolveBlob() in _vlm-matrix-common.js.
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

  // mode: 'two-models'     — vary (model · mmproj); the engine is FIXED (see
  //                          `engine`). base = f16 mmproj, candidate = q8. Runs on
  //                          all platforms. (This is the active mode.)
  //       'several-sources' — vary the engine (addon/fabric-cli/upstream-cli); the
  //                          model is FIXED. Desktop-only CLI engines.
  mode: 'two-models',

  // Inference engine for two-models mode (the fixed parameter). Linux can override
  // with QVAC_VLM_ENGINE; mobile uses this default. 'addon' = @qvac/llm-llamacpp JS
  // binding (built on the qvac-fabric fork; runs on Linux + S25). 'fabric-cli' /
  // 'upstream-cli' = native llama-mtmd-cli (desktop-only; not yet wired here).
  engine: 'addon',
  base: 'f16',
  candidate: 'q8',

  // Active preset for the device leg (and the Linux default). Override on Linux
  // with QVAC_VLM_PRESET. 'compare' = the current focus (Qwen3.5 f16-vs-q8 mmproj,
  // a few samples so quality is non-zero); 'smoke' = 1-cell/1-task/1-sample wiring
  // check; 'full' = the real test set.
  defaultPreset: 'compare',

  // A preset narrows the matrix. `null` fields fall back to the harness defaults
  // (all cells / all fixture tasks / samples=isMobile?2:5 / devices=cpu+gpu).
  presets: {
    full: { cells: ALL_CELLS, tasks: null, samplesPerTask: null, devices: null },
    smoke: { cells: [{ model: 'qwen', mmproj: 'q8' }], tasks: ['vqav2'], samplesPerTask: 1, devices: null },
    // Qwen3.5: registry f16 mmproj vs registry q8 mmproj. 5 cleanly open-licensed
    // tasks (TextVQA/VizWiz/GQA = CC-BY-4.0, DocVQA = Apache-2.0, AI2D = CC-BY-SA-4.0)
    // × 3 samples = 15 images, all ≤1024 px (see scripts/build-vlm-fixture.cjs).
    compare: {
      cells: [{ model: 'qwen', mmproj: 'f16' }, { model: 'qwen', mmproj: 'q8' }],
      tasks: ['textvqa', 'vizwiz', 'gqa', 'docvqa', 'ai2d'],
      samplesPerTask: 3,
      devices: null
    }
  }
}
