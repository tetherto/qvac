'use strict'

// CosyVoice3 + LavaSR enhancer, model-backed: the enhanced output must be
// reported as 48 kHz on both the batch path and native chunk streaming.
//
// Separate from lavasr-enhancer.test.js because the mobile suite shards by
// engine: that file runs on the 'chatterbox' row, which never stages
// CosyVoice3's ~2.4 GB model dir, while this one is listed on the dedicated
// 'cosyvoice' row that pre-stages it (see test/mobile/test-groups.json).
//
// CosyVoice3 is CPU-only in this iteration, and the addon hands the enhancer the
// engine's *resolved* device, so these also pin that the enhancer really loaded
// and ran (enhancerBackendDevice=0) rather than silently staying off. Text is
// kept short to bound CPU LM-decode time in CI, as in cosyvoice3.test.js.
//
// Stage the enhancer GGUF via scripts/convert-lavasr-enhancer-to-gguf.py (from
// the public LavaSRcpp ONNX release) into models/lavasr/lavasr-enhancer.gguf,
// or set LAVASR_ENHANCER_GGUF.

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')
const TTSGgml = require('@qvac/tts-ggml')

const { ensureLavaSREnhancerGguf, ensureCosyvoiceModel } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
// CosyVoice3 segfaults at load/synthesis on the win32-x64 desktop lane; mirrors
// the skip in cosyvoice3.test.js so the Windows lane stays green.
const SKIP_COSYVOICE = platform === 'win32'

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

test(
  'CosyVoice3 + LavaSR enhancer (batch) reports 48 kHz enhanced output',
  { timeout: 900000, skip: SKIP_COSYVOICE },
  async (t) => {
    const baseDir = getBaseDir()
    const enh = await ensureLavaSREnhancerGguf({
      targetDir: path.join(baseDir, 'models', 'lavasr')
    })
    if (!enh.success) {
      t.comment('LavaSR enhancer GGUF not staged; skipping.')
      t.pass('skipped — no enhancer GGUF')
      return
    }
    const dl = await ensureCosyvoiceModel({
      targetDir: path.join(baseDir, 'models', 'cosyvoice3')
    })
    if (!dl.success) {
      t.fail('CosyVoice3 model files not available — registry fetch failed.')
      return
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_COSYVOICE3,
      files: { cosyvoiceModelDir: dl.modelDir, lavasrEnhancer: enh.path },
      config: { language: 'en', useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const r = await runAndCollect(model, 'Hello from CosyVoice.')
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
    const enh = await ensureLavaSREnhancerGguf({
      targetDir: path.join(baseDir, 'models', 'lavasr')
    })
    if (!enh.success) {
      t.comment('LavaSR enhancer GGUF not staged; skipping.')
      t.pass('skipped — no enhancer GGUF')
      return
    }
    const dl = await ensureCosyvoiceModel({
      targetDir: path.join(baseDir, 'models', 'cosyvoice3')
    })
    if (!dl.success) {
      t.fail('CosyVoice3 model files not available — registry fetch failed.')
      return
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_COSYVOICE3,
      files: { cosyvoiceModelDir: dl.modelDir, lavasrEnhancer: enh.path },
      streamChunkTokens: 25, // native chunk streaming + enhancer (the path)
      config: { language: 'en', useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const updates = []
      const response = await model.run({ input: 'Hello from CosyVoice.', type: 'text' })
      await response
        .onUpdate((d) => {
          if (d && d.outputArray) updates.push(d)
        })
        .await()

      const total = updates.reduce((acc, u) => acc + u.outputArray.length, 0)
      t.ok(updates.length >= 1, 'streamed at least one chunk event')
      t.ok(total > 0, 'streamed enhanced audio produced samples')
      // Every chunk carrying audio must be tagged at the enhanced 48 kHz rate
      // rather than CosyVoice3's native 24 kHz — the mislabel this path prevents.
      for (const u of updates) {
        if (u.outputArray.length > 0 && u.sampleRate != null) {
          t.is(u.sampleRate, 48000, 'streamed enhanced chunk reports 48 kHz')
        }
      }
      const isLastCount = updates.filter((u) => u.isLast === true).length
      t.ok(isLastCount <= 1, 'at most one isLast=true across streamed chunks')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)
