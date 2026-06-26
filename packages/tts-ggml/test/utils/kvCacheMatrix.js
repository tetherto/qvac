'use strict'

// Reusable harness for the Chatterbox KV-cache × engine × backend matrix.
//
// WHY THIS EXISTS (QVAC-21401):
//   `@qvac/tts-ggml` 0.3.2 (QVAC-19557) flipped the default T3 KV-cache
//   dtype to `q8_0` to fix an iOS peak-memory OOM.  That default shipped
//   validated only on the **Turbo** model, on **CPU**, and by a load-time
//   probe (`chatterbox_resolve_kv_type`) that only checks `flash_attn_ext`.
//   But the **multilingual** step graph (`eval_step_mtl`) issues a `ggml_cont`
//   on the KV cache, and ggml-speech's **Metal** backend has no q8_0→q8_0
//   `CONT`, so a q8_0 KV cache hard-aborts the MTL model mid-synthesis on
//   Metal with `GGML_ABORT("unsupported op 'CONT'")`.  The exact matrix cell
//   that contained the bug — multilingual × GPU(Metal) × q8_0 — was never
//   exercised by any test:
//     - gpu-smoke.test.js runs GPU but only the Turbo (en) model.
//     - chatterbox-mtl.test.js runs the MTL model but only on CPU.
//   This harness makes that whole matrix a first-class, reusable sweep so a
//   future KV-default / engine / backend change can't silently re-open the
//   hole.  See test/integration/chatterbox-kv-cache-gpu.test.js for the
//   suite that drives it.
//
// HOW IT DETECTS THE REGRESSION:
//   A `CONT`-on-q8_0 abort is a native `GGML_ABORT` -> SIGABRT: it kills the
//   whole Bare test process, so the CI step exits non-zero.  Post-fix the
//   synth completes and the assertions below verify non-empty audio + the
//   GPU backend actually engaged.  Either way the matrix cell is no longer a
//   blind spot.

const os = require('bare-os')
const proc = require('bare-process')
const path = require('bare-path')

const TTSGgml = require('@qvac/tts-ggml')
const { runTTS } = require('./runTTS')
const { resolveRefWavPath } = require('./runChatterboxTTS')
const { ensureChatterboxModels, ensureChatterboxMtlModels } = require('./downloadModel')

const CHATTERBOX_SAMPLE_RATE = 24000

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const NO_GPU = !!(proc.env && proc.env.NO_GPU === 'true')
const RELAX = !!(proc.env && proc.env.QVAC_TTS_GPU_SMOKE_RELAX === '1')

// Opt-in switch to ALSO exercise KV dtypes that are known to abort the
// multilingual model on some GPU backends (q8_0 on Metal) until the
// backend-aware tts-cpp fix lands (extend `chatterbox_resolve_kv_type` to
// probe `CONT`, not just flash-attn — see qvac-ext-lib-whisper.cpp).  OFF by
// default so the standard CI run stays green on the f16 default; flip it on
// to validate that follow-up fix once it ships.
const PROBE_UNSAFE = !!(proc.env && proc.env.QVAC_TTS_KV_PROBE_UNSAFE === '1')

// KV dtypes every GPU backend wired into tts-cpp can actually *run the whole
// MTL step graph with* (flash-attn + the CONT eval_step_mtl issues on the KV
// cache).  q8_0 is deliberately excluded: it is memory-cheapest but only
// works where the backend implements the q8_0 CONT (CPU, CUDA) — it aborts
// the MTL model on Metal (QVAC-21401).
const GPU_SAFE_KV_TYPES = ['f16', 'f32']

// Every selectable dtype.  `undefined` is the package default (must itself be
// GPU-safe — that invariant is locked by the C++ tripwire
// test_chatterbox_config.cpp::DefaultKvCacheTypeIsGpuSafeNotQuantized).
const ALL_KV_TYPES = [undefined, 'f16', 'f32', 'q8_0']

// Both Chatterbox model families.  The MTL variant is the one that regressed;
// Turbo is kept in the sweep so a fix that helps one but breaks the other is
// still caught.
const CHATTERBOX_VARIANTS = ['mtl', 'turbo']

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

// Platforms that wire up a GPU backend in tts-cpp's vcpkg port today
// (mirrors gpu-smoke.test.js::expectsGpu): darwin/ios -> Metal,
// linux/win32 -> Vulkan, android -> Vulkan/OpenCL.
function expectsGpu () {
  return (
    platform === 'darwin' ||
    platform === 'ios' ||
    platform === 'linux' ||
    platform === 'win32' ||
    platform === 'android'
  )
}

function backendIdToName (id) {
  switch (id) {
    case 0: return 'CPU'
    case 1: return 'Metal'
    case 2: return 'CUDA'
    case 3: return 'Vulkan'
    case 4: return 'OpenCL'
    case 99: return 'other-GPU'
    default: return `unknown(${id})`
  }
}

function kvLabel (kvCacheType) {
  return kvCacheType == null ? 'default' : kvCacheType
}

// Resolve the GGUF pair for a Chatterbox variant.  Paths are passed
// EXPLICITLY (not via modelDir auto-detect) so the variant is unambiguous
// even when both the Turbo and MTL GGUF sets live in the same models/ dir
// (they do once both ensure* helpers have run in one CI job).
function chatterboxFiles (variant, modelDir) {
  if (variant === 'mtl') {
    return {
      modelDir,
      t3Model: path.join(modelDir, 'chatterbox-t3-mtl.gguf'),
      s3genModel: path.join(modelDir, 'chatterbox-s3gen-mtl.gguf')
    }
  }
  return {
    modelDir,
    t3Model: path.join(modelDir, 'chatterbox-t3-turbo.gguf'),
    s3genModel: path.join(modelDir, 'chatterbox-s3gen.gguf')
  }
}

async function ensureModelsFor (variant, modelsDir) {
  return variant === 'mtl'
    ? ensureChatterboxMtlModels({ targetDir: modelsDir })
    : ensureChatterboxModels({ targetDir: modelsDir })
}

// A short, real multilingual utterance per language.  Any text triggers the
// crash (the alignment/EOS probe reads the KV cache on the first decode step,
// not just at the end), but a real sentence keeps the run representative.
const SAMPLE_TEXT = {
  en: 'The quick brown fox jumps over the lazy dog.',
  es: 'El zorro marrón salta sobre el perro perezoso.',
  it: 'La veloce volpe marrone salta sopra il cane pigro.',
  fr: 'Le renard brun saute par-dessus le chien paresseux.'
}

function textFor (language) {
  return SAMPLE_TEXT[language] || SAMPLE_TEXT.en
}

async function loadChatterbox ({ variant, modelDir, refWavPath, language, useGPU, kvCacheType }) {
  const options = {
    files: chatterboxFiles(variant, modelDir),
    referenceAudio: refWavPath,
    config: {
      language: language || (variant === 'mtl' ? 'es' : 'en'),
      useGPU: !!useGPU
    },
    opts: { stats: true }
  }
  // Omit when undefined so the addon applies its own (GPU-safe) default —
  // that "unset -> default" path is exactly what regressed, so we cover it.
  if (kvCacheType != null) options.kvCacheType = kvCacheType
  const model = new TTSGgml(options)
  await model.load()
  return model
}

// Mirrors gpu-smoke.test.js::assertGpuBackend; kept here so the matrix
// harness is self-contained.  `allowPolicyCpu` lets a vendor tts-cpp
// declines (e.g. Chatterbox on ARM Mali, gpuUnsupported=1) count as a pass.
function assertGpuEngaged (t, tag, stats, allowPolicyCpu = true) {
  if (!stats) {
    t.fail(`${tag}: no response.stats returned (cannot verify backend)`)
    return
  }
  const dev = stats.backendDevice
  const id = stats.backendId
  const name = backendIdToName(id)
  console.log(`[${tag}] backendDevice=${dev} backendId=${id} (${name})`)

  if (!expectsGpu()) {
    t.is(dev, 0, `${tag}/${platform}: backendDevice must be 0 (CPU) where no GPU is wired in`)
    return
  }
  if (allowPolicyCpu && dev === 0 && stats.gpuUnsupported) {
    t.pass(`${tag}/${platform}: GPU present but declined by policy (gpuUnsupported=1); using CPU`)
    return
  }
  if (dev !== 1) {
    const msg = `${tag}/${platform}: expected GPU backend, got ${name} (backendDevice=${dev}). ` +
      'useGPU=true was requested but the engine fell back to CPU.'
    if (RELAX) {
      t.comment(`WARNING (relaxed): ${msg}`)
      t.pass(`${tag}: GPU check relaxed`)
    } else {
      t.fail(msg)
    }
  }
}

// Run one synth to completion and assert it produced audio.  Surviving this
// call at all is the core regression signal: a q8_0 CONT abort on Metal would
// have SIGABRT'd the process before we got here.
async function assertSynthesisCompletes (t, model, { tag, text, language, minSamples = 2000, expectGpu = false, allowPolicyCpu = true }) {
  const result = await runTTS(
    model,
    { text: text || textFor(language) },
    { minSamples },
    { sampleRate: CHATTERBOX_SAMPLE_RATE, engineTag: tag }
  )
  console.log(`  ${result.output}`)
  if (result.data && result.data.error) {
    t.fail(`${tag}: synthesis threw: ${result.data.error}`)
    return result
  }
  t.ok(result.passed, `${tag}: synthesis completed and met sample expectations`)
  t.ok(result.data && result.data.sampleCount > 0, `${tag}: produced non-empty audio`)
  if (expectGpu) {
    assertGpuEngaged(t, tag, result.data && result.data.stats, allowPolicyCpu)
  }
  return result
}

module.exports = {
  CHATTERBOX_SAMPLE_RATE,
  CHATTERBOX_VARIANTS,
  GPU_SAFE_KV_TYPES,
  ALL_KV_TYPES,
  NO_GPU,
  RELAX,
  PROBE_UNSAFE,
  isMobile,
  platform,
  getBaseDir,
  expectsGpu,
  backendIdToName,
  kvLabel,
  textFor,
  resolveRefWavPath,
  ensureModelsFor,
  loadChatterbox,
  assertGpuEngaged,
  assertSynthesisCompletes
}
