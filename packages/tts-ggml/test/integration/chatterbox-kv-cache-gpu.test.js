'use strict'

// Chatterbox KV-cache × engine × GPU regression suite (QVAC-21401).
//
// This is the test that would have caught the multilingual Metal abort:
// `@qvac/tts-ggml` 0.3.2–0.3.5 defaulted the T3 KV cache to `q8_0`, which
// hard-aborts the **multilingual** Chatterbox model on a **Metal** GPU
// (`GGML_ABORT("unsupported op 'CONT'")` inside `eval_step_mtl`), while the
// EN Turbo model and the CPU backend were fine.  No existing test covered
// the MTL × GPU × q8_0 cell:
//   - gpu-smoke.test.js  -> GPU, but Turbo (en) only.
//   - chatterbox-mtl.test.js -> MTL, but CPU only.
//
// The sweep below loads each Chatterbox variant on the GPU across the
// GPU-safe KV dtypes (plus the package default) and asserts synthesis runs
// to completion and the GPU actually engaged.  A regressed default (or any
// dtype the active GPU backend can't run the MTL graph with) SIGABRTs the
// Bare process, failing the CI step.
//
// Coverage notes (see also: integration-test-tts-ggml.yml matrix):
//   - Real **Metal** coverage comes from the iOS Device Farm leg
//     (integration-mobile-test-tts-ggml.yml), which auto-includes this file
//     via test/mobile/integration.auto.cjs.  The desktop macOS-arm64 runner
//     is `no_gpu:true` (hosted paravirtual Metal is broken), so it skips.
//   - Linux/Windows GPU runners exercise Vulkan; there tts-cpp already forces
//     quantized KV -> f32, so the q8_0 cell can't reproduce the Metal bug,
//     but the f16/f32/default cells still guard those backends.
//   - NO_GPU=true (the no-GPU matrix entries) skips the whole file.

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')

const {
  CHATTERBOX_VARIANTS,
  GPU_SAFE_KV_TYPES,
  NO_GPU,
  PROBE_UNSAFE,
  getBaseDir,
  kvLabel,
  resolveRefWavPath,
  ensureModelsFor,
  loadChatterbox,
  assertSynthesisCompletes
} = require('../utils/kvCacheMatrix')

const LANGUAGE_FOR = { mtl: 'es', turbo: 'en' }

// Load `variant` on the GPU with `kvCacheType`, synthesize once, assert it
// completed and engaged the GPU, then unload.  Shared by every matrix entry.
async function runGpuCase (t, variant, kvCacheType) {
  const baseDir = getBaseDir()
  const modelsDir = path.join(baseDir, 'models')

  const download = await ensureModelsFor(variant, modelsDir)
  if (!download.success) {
    t.fail(`Chatterbox ${variant} GGUFs not available - registry fetch failed. ` +
      'Run `npm run download-models:registry` or stage models locally.')
    return
  }

  const refWavPath = resolveRefWavPath({})
  if (!fs.existsSync(refWavPath)) {
    t.pass('Skipped: reference audio missing')
    return
  }

  const tag = `Chatterbox ${variant.toUpperCase()}/GPU/kv=${kvLabel(kvCacheType)}`
  const model = await loadChatterbox({
    variant,
    modelDir: download.targetDir,
    refWavPath,
    language: LANGUAGE_FOR[variant],
    useGPU: true,
    kvCacheType
  })
  try {
    // Chatterbox now runs on the ARM Mali GPU, so the GPU is required here.
    await assertSynthesisCompletes(t, model, {
      tag,
      language: LANGUAGE_FOR[variant],
      minSamples: 2000,
      expectGpu: true,
      allowPolicyCpu: false
    })
  } finally {
    try { await model.unload() } catch (_e) {}
  }
}

// ── Headline regression: the exact cell that shipped broken ──────────────
// MTL + useGPU=true + DEFAULT KV cache.  Pre-QVAC-21401 (q8_0 default) this
// aborts on Metal; post-fix (f16 default) it completes.
test('Chatterbox MTL + useGPU=true + DEFAULT KV cache synthesizes to completion (QVAC-21401)',
  { timeout: 600000, skip: NO_GPU },
  async (t) => {
    await runGpuCase(t, 'mtl', undefined)
  })

// ── Full GPU-safe sweep: every variant × {default, f16, f32} on GPU ──────
for (const variant of CHATTERBOX_VARIANTS) {
  for (const kvCacheType of [undefined, ...GPU_SAFE_KV_TYPES]) {
    // The MTL/default cell is the headline test above; skip the duplicate.
    if (variant === 'mtl' && kvCacheType === undefined) continue
    test(`Chatterbox ${variant.toUpperCase()} + useGPU=true + kv=${kvLabel(kvCacheType)} synthesizes to completion`,
      { timeout: 600000, skip: NO_GPU },
      async (t) => {
        await runGpuCase(t, variant, kvCacheType)
      })
  }
}

// ── Opt-in: known-unsafe dtypes on the GPU (QVAC_TTS_KV_PROBE_UNSAFE=1) ──
// q8_0 still aborts the MTL model on Metal until the backend-aware tts-cpp
// fix lands (extend `chatterbox_resolve_kv_type` to probe CONT, not just
// flash-attn).  Off by default so CI stays green; turn it on to verify that
// follow-up once it ships (it should either complete or cleanly fall back to
// f32 — never SIGABRT).
for (const variant of CHATTERBOX_VARIANTS) {
  test(`Chatterbox ${variant.toUpperCase()} + useGPU=true + kv=q8_0 does not abort (opt-in: QVAC_TTS_KV_PROBE_UNSAFE)`,
    { timeout: 600000, skip: NO_GPU || !PROBE_UNSAFE },
    async (t) => {
      await runGpuCase(t, variant, 'q8_0')
    })
}
