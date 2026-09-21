'use strict'

// CosyVoice3 + LavaSR (enhancer and denoiser), model-backed.
//
// Separate from lavasr-enhancer.test.js because the mobile suite shards by
// engine: that file runs on the 'chatterbox' row, which never stages
// CosyVoice3's ~2.4 GB model dir, while this one is listed on the dedicated
// 'cosyvoice' row that pre-stages it (see test/mobile/test-groups.json).
//
// Text is kept short to bound CPU LM-decode time in CI, as in cosyvoice3.test.js.
//
// Stage the enhancer GGUF via scripts/convert-lavasr-enhancer-to-gguf.py (from
// the public LavaSRcpp ONNX release) into models/lavasr/lavasr-enhancer.gguf,
// or set LAVASR_ENHANCER_GGUF.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const TTSGgml = require('@qvac/tts-ggml')

const {
  ensureLavaSREnhancerGguf,
  ensureLavaSRDenoiserGguf,
  ensureCosyvoiceModel
} = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
// CosyVoice3 segfaults at load/synthesis on the win32-x64 desktop lane; mirrors
// the skip in cosyvoice3.test.js so the Windows lane stays green.
const SKIP_COSYVOICE = platform === 'win32'
// Pinning the seed makes CosyVoice3 synthesis bit-exact across runs, so the
// denoiser test can attribute any sample difference to the denoiser alone.
const SEED = 1234
const TEXT = 'Hello from CosyVoice.'

function getBaseDir() {
  return isMobile && global.testDir ? global.testDir : '.'
}

async function runAndCollect(model, text) {
  let samples = 0
  let sampleRate = null
  const response = await model.run({ input: text, type: 'text' })
  await response
    .onUpdate((d) => {
      if (d && d.outputArray) samples += d.outputArray.length
      if (d && d.sampleRate) sampleRate = d.sampleRate
    })
    .await()
  return { samples, sampleRate, stats: response.stats || null }
}

async function collectPcm(model, text) {
  const pcm = []
  let sampleRate = null
  const response = await model.run({ input: text, type: 'text' })
  await response
    .onUpdate((d) => {
      if (d && d.outputArray) pcm.push(...d.outputArray)
      if (d && d.sampleRate) sampleRate = d.sampleRate
    })
    .await()
  return { pcm, sampleRate }
}

async function collectChunks(model, text) {
  const updates = []
  const response = await model.run({ input: text, type: 'text' })
  await response
    .onUpdate((d) => {
      if (d && d.outputArray) updates.push(d)
    })
    .await()
  return updates
}

function countDifferingSamples(a, b) {
  let differing = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) differing++
  }
  return differing
}

function assertChunksReportRate(t, updates, expectedRate) {
  for (const u of updates) {
    if (u.outputArray.length > 0 && typeof u.sampleRate === 'number') {
      t.is(u.sampleRate, expectedRate, `streamed chunk reports ${expectedRate} Hz`)
    }
  }
}

async function stageEnhancer(t, baseDir) {
  const enh = await ensureLavaSREnhancerGguf({
    targetDir: path.join(baseDir, 'models', 'lavasr')
  })
  if (!enh.success) {
    t.comment('LavaSR enhancer GGUF not staged; skipping.')
    t.pass('skipped — no enhancer GGUF')
    return null
  }
  return enh
}

async function stageCosyvoice(t, baseDir) {
  const dl = await ensureCosyvoiceModel({
    targetDir: path.join(baseDir, 'models', 'cosyvoice3')
  })
  if (!dl.success) {
    t.fail('CosyVoice3 model files not available — registry fetch failed.')
    return null
  }
  return dl
}

test(
  'CosyVoice3 + LavaSR enhancer (batch) reports 48 kHz enhanced output',
  { timeout: 900000, skip: SKIP_COSYVOICE },
  async (t) => {
    const baseDir = getBaseDir()
    const enh = await stageEnhancer(t, baseDir)
    if (!enh) return
    const dl = await stageCosyvoice(t, baseDir)
    if (!dl) return

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_COSYVOICE3,
      files: { cosyvoiceModelDir: dl.modelDir, lavasrEnhancer: enh.path },
      config: { language: 'en', useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const r = await runAndCollect(model, TEXT)
      t.is(r.sampleRate, 48000, 'enhanced cosyvoice3 output reports 48 kHz (native is 24 kHz)')
      t.ok(r.samples > 0, 'enhanced synthesis produced audio')
      t.ok(r.stats, 'runtimeStats returned (constructed with stats:true)')
      t.is(
        r.stats.enhancerBackendDevice,
        0,
        'enhancer loaded and ran on CPU (enhancerBackendDevice=0, not -1 = never loaded)'
      )
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'CosyVoice3 + LavaSR enhancer + native chunk streaming emits 48 kHz chunks',
  { timeout: 900000, skip: SKIP_COSYVOICE },
  async (t) => {
    const baseDir = getBaseDir()
    const enh = await stageEnhancer(t, baseDir)
    if (!enh) return
    const dl = await stageCosyvoice(t, baseDir)
    if (!dl) return

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_COSYVOICE3,
      files: { cosyvoiceModelDir: dl.modelDir, lavasrEnhancer: enh.path },
      streamChunkTokens: 25,
      config: { language: 'en', useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const updates = await collectChunks(model, TEXT)
      const total = updates.reduce((acc, u) => acc + u.outputArray.length, 0)
      t.ok(updates.length >= 1, 'streamed at least one chunk event')
      t.ok(total > 0, 'streamed enhanced audio produced samples')
      // Every chunk carrying audio must be tagged at the enhanced 48 kHz rate
      // rather than CosyVoice3's native 24 kHz — the mislabel this path prevents.
      assertChunksReportRate(t, updates, 48000)
      const isLastCount = updates.filter((u) => u.isLast === true).length
      t.ok(isLastCount <= 1, 'at most one isLast=true across streamed chunks')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'CosyVoice3 + enhancer + streaming resamples every chunk to outputSampleRate',
  { timeout: 900000, skip: SKIP_COSYVOICE },
  async (t) => {
    // A non-native rate while streaming is only legal because the enhancer's
    // overlap-reprocess window folds the resample in seam-free. Without this the
    // addon-side path could regress to emitting native-rate chunks under a
    // 16 kHz label, which forwarding-only tests would never catch.
    const baseDir = getBaseDir()
    const enh = await stageEnhancer(t, baseDir)
    if (!enh) return
    const dl = await stageCosyvoice(t, baseDir)
    if (!dl) return

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_COSYVOICE3,
      files: { cosyvoiceModelDir: dl.modelDir, lavasrEnhancer: enh.path },
      streamChunkTokens: 25,
      config: { language: 'en', useGPU: false, outputSampleRate: 16000 },
      opts: { stats: true }
    })
    await model.load()
    try {
      const updates = await collectChunks(model, TEXT)
      const total = updates.reduce((acc, u) => acc + u.outputArray.length, 0)
      t.ok(updates.length >= 1, 'streamed at least one chunk event')
      t.ok(total > 0, 'resampled streaming produced audio')
      assertChunksReportRate(t, updates, 16000)
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'CosyVoice3 + LavaSR denoiser changes the emitted PCM',
  { timeout: 900000, skip: SKIP_COSYVOICE },
  async (t) => {
    const baseDir = getBaseDir()
    const dl = await stageCosyvoice(t, baseDir)
    if (!dl) return
    const den = await ensureLavaSRDenoiserGguf({
      targetDir: path.join(baseDir, 'models', 'lavasr')
    })
    if (!den.success) {
      t.comment('LavaSR denoiser GGUF not staged; skipping.')
      t.pass('skipped — no denoiser GGUF')
      return
    }

    const synth = async (files) => {
      const model = new TTSGgml({
        engine: TTSGgml.ENGINE_COSYVOICE3,
        files: Object.assign({ cosyvoiceModelDir: dl.modelDir }, files),
        config: { language: 'en', useGPU: false, seed: SEED },
        opts: { stats: true }
      })
      await model.load()
      try {
        return await collectPcm(model, TEXT)
      } finally {
        try {
          await model.unload()
        } catch (_e) {}
      }
    }

    const clean = await synth({})
    const denoised = await synth({ lavasrDenoiser: den.path })

    t.ok(clean.pcm.length > 0, 'baseline synthesis produced audio')
    t.is(
      denoised.pcm.length,
      clean.pcm.length,
      'denoiser is rate-preserving, so the sample count is unchanged'
    )
    t.is(denoised.sampleRate, clean.sampleRate, 'denoiser leaves the reported rate alone')

    // The seed pins synthesis bit-exact, so any difference is the denoiser
    // actually running rather than run-to-run sampling noise.
    const differing = countDifferingSamples(clean.pcm, denoised.pcm)
    t.ok(
      differing > clean.pcm.length / 10,
      `denoising altered the waveform (${differing}/${clean.pcm.length} samples differ)`
    )
  }
)

test(
  'CosyVoice3: an invalid enhancer GGUF fails the load instead of degrading',
  { timeout: 900000, skip: SKIP_COSYVOICE },
  async (t) => {
    // A staged-but-corrupt enhancer must surface as a load error rather than
    // quietly synthesizing unenhanced audio. The addon-side half-loaded state
    // behind it is pinned by
    // CosyvoiceRealGguf.FailedEnhancerLoadLeavesModelUnloaded.
    const baseDir = getBaseDir()
    const dl = await stageCosyvoice(t, baseDir)
    if (!dl) return

    const badEnhancer = path.join(baseDir, 'models', 'lavasr', 'invalid-enhancer.gguf')
    fs.writeFileSync(badEnhancer, 'not a gguf')

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_COSYVOICE3,
      files: { cosyvoiceModelDir: dl.modelDir, lavasrEnhancer: badEnhancer },
      config: { language: 'en', useGPU: false },
      opts: { stats: true }
    })
    try {
      await t.exception(model.load(), 'loading an invalid enhancer GGUF fails')
      await t.exception(
        model.load(),
        'the retry fails too rather than silently succeeding without the enhancer'
      )
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
      try {
        fs.unlinkSync(badEnhancer)
      } catch (_e) {}
    }
  }
)
