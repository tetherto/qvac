'use strict'
// QVAC-19178: single source of truth for the VLM benchmark (config + presets).
//
// One config drives every target. A "target" is a (platform × backend) pair:
//   • desktop platform — Linux by default; CPU and GPU where the runner supports it.
//   • mobile  platform — Samsung Galaxy S25 (AWS Device Farm) by default; CPU and GPU.
// Adding a desktop OS or a different phone is a workflow/runner change, not a config
// change — this file stays platform-agnostic (it only names cpu/gpu via `devices`).
//
// How each target reads this config (stage.cjs copies the file to the mobile bundle):
//   • desktop — the active preset is QVAC_VLM_PRESET, with per-field QVAC_VLM_* overrides.
//   • mobile  — NO env passthrough (Device Farm forwards none), so the on-device run is
//     always `defaultPreset` below. To change what mobile runs, edit `defaultPreset`.
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
// every target); the report shows Source = "Registry" for these. The live
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

// Open-licensed fixture tasks (regenerate/curate via build-fixture.cjs;
// per-image attribution in fixture.NOTICE.md).
const TASKS = ['textvqa', 'vizwiz', 'gqa', 'docvqa', 'ai2d']

// A "cell" is one (model · mmproj) configuration. two-models mode compares any two
// cells — that can be two mmproj variants of the SAME model (the default: qwen f16
// vs qwen q8) or two DIFFERENT models (e.g. qwen vs gemma). A preset picks the cells.
const ALL_CELLS = [
  { model: 'qwen', mmproj: 'q8' },
  { model: 'qwen', mmproj: 'f16' },
  { model: 'gemma', mmproj: 'q8' },
  { model: 'gemma', mmproj: 'f16' }
]

module.exports = {
  // ════════════════════════ MODES ════════════════════════
  // The benchmark runs in ONE comparison mode. The workflow's `matrix_mode` input
  // sets it on desktop (env QVAC_VLM_MODE); on mobile (no env passthrough) the active
  // preset's `mode` decides.
  //
  //   two-models       Hold the engine fixed, vary the MODEL. Compares any two cells
  //                    — two mmproj variants of one model (default) or two different
  //                    models. Runs on every target (desktop + mobile, CPU + GPU).
  //   several-sources  Hold the model fixed, vary the ENGINE (addon / fabric-cli /
  //                    upstream-cli). Desktop-only — fabric/upstream are native
  //                    llama-mtmd-cli binaries that don't ship in the mobile app.
  mode: 'two-models',

  // ── two-models settings ──
  // `base`/`candidate` name the two columns of the Highlights delta table. With the
  // default cells they're mmproj labels (f16 vs q8); when comparing two models, set
  // them to whatever distinguishes the two cells.
  base: 'f16', //       label for the "base" column
  candidate: 'q8', //   label for the "candidate" column
  engine: 'addon', //   the fixed engine (addon | fabric-cli | upstream-cli)

  // ── several-sources settings ──
  engines: ['addon', 'fabric-cli', 'upstream-cli'], // engines compared (model fixed below)

  // ════════════════════════ SHARED ════════════════════════
  models: MODELS, //    model catalog (each blob has a source descriptor + registry tag)
  allCells: ALL_CELLS,

  // The default preset: used verbatim on mobile, and the desktop default when
  // QVAC_VLM_PRESET is unset. A preset bundles the run settings; on desktop each field
  // is individually overridable by env:
  //   QVAC_VLM_SAMPLES→samplesPerTask · QVAC_VLM_REPEATS→repeats
  //   QVAC_VLM_DEVICES→devices (csv, e.g. "cpu" or "cpu,gpu") · QVAC_VLM_TASKS→tasks (csv)
  // `devices: null` = both CPU and GPU where applicable; `tasks: null` = all fixture tasks.
  defaultPreset: 'compare',

  // Presets are the flexibility knob: clone one, change cells/tasks/samples, and point
  // a run at it. The set below is what we currently evaluate; they are not exhaustive.
  presets: {
    // ── two-models presets ──────────────────────────────────────────────
    // DEFAULT eval: f16 vs q8 mmproj on Qwen3.5, the 5 open-licensed tasks (15 images ≤1024px).
    compare: { mode: 'two-models', cells: [{ model: 'qwen', mmproj: 'f16' }, { model: 'qwen', mmproj: 'q8' }], tasks: TASKS, samplesPerTask: 3, repeats: 3, devices: null },
    // The full matrix (all model·mmproj cells × all tasks) — also shows qwen-vs-gemma.
    full: { mode: 'two-models', cells: ALL_CELLS, tasks: null, samplesPerTask: 5, repeats: 3, devices: null },
    // 1 cell / 1 task / 1 sample — pipeline wiring check (fast, used for CI smoke tests).
    smoke: { mode: 'two-models', cells: [{ model: 'qwen', mmproj: 'q8' }], tasks: ['textvqa'], samplesPerTask: 1, repeats: 1, devices: null },

    // ── several-sources preset (desktop only) ───────────────────────────
    // ONE fixed model (Qwen3.5 + q8 mmproj) across addon + fabric-cli + upstream-cli.
    sources: { mode: 'several-sources', cells: [{ model: 'qwen', mmproj: 'q8' }], engines: ['addon', 'fabric-cli', 'upstream-cli'], tasks: TASKS, samplesPerTask: 3, repeats: 3, devices: null }
  }
}
