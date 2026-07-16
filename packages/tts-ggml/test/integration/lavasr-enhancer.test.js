'use strict'

// LavaSR enhancer integration + regression tests.
//
// The construct-time tests need no models and always run in CI. They pin:
// enhancer + Chatterbox native chunk streaming is now supported (constructs and
// forwards both knobs — the addon enhances each chunk seam-free), and a
// misconfigured enhancer can't silently become a no-op (an unknown
// enhancer.type throws). The model-backed tests assert the enhanced output is
// reported as 48 kHz for both engines (incl. Chatterbox native streaming);
// they are gated on the converted enhancer GGUF being staged, and skip cleanly
// otherwise.
//
// Stage the enhancer GGUF via scripts/convert-lavasr-enhancer-to-gguf.py (from
// the public LavaSRcpp ONNX release) into models/lavasr/lavasr-enhancer.gguf,
// or set LAVASR_ENHANCER_GGUF.

const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')
const TTSGgml = require('@qvac/tts-ggml')

const {
  ensureLavaSREnhancerGguf,
  ensureSupertonicModel,
  ensureChatterboxModels
} = require('../utils/downloadModel')
const { resolveRefWavPath } = require('../utils/runChatterboxTTS')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
// Mirrors gpu-smoke.test.js: CI runners without a real GPU export NO_GPU=true to
// skip the GPU-gated entries; QVAC_TTS_GPU_SMOKE_RELAX=1 downgrades a GPU->CPU
// fallback from a failure to a warning (e.g. a Linux host with no Vulkan SDK).
const NO_GPU = proc.env && proc.env.NO_GPU === 'true'
const RELAX = proc.env && proc.env.QVAC_TTS_GPU_SMOKE_RELAX === '1'

function getBaseDir() {
  return isMobile && global.testDir ? global.testDir : '.'
}

function backendIdToName(id) {
  switch (id) {
    case 0:
      return 'CPU'
    case 1:
      return 'Metal'
    case 2:
      return 'CUDA'
    case 3:
      return 'Vulkan'
    case 4:
      return 'OpenCL'
    case 99:
      return 'other-GPU'
    default:
      return `unknown(${id})`
  }
}

// Platforms that wire a GPU backend into tts-cpp's vcpkg port (default-features):
// darwin/ios -> metal; linux/win32 -> vulkan; android -> vulkan + opencl.
function expectsGpu() {
  return (
    platform === 'darwin' ||
    platform === 'ios' ||
    platform === 'linux' ||
    platform === 'win32' ||
    platform === 'android'
  )
}

// Strict check that the LavaSR *enhancer* network engaged the GPU. Reads the
// enhancer-specific backend surfaced by ChatterboxModel/SupertonicModel
// runtimeStats (enhancerBackendDevice: -1 none / 0 CPU / 1 GPU;
// enhancerBackendId mirrors backendId). This is the enhancer counterpart to
// gpu-smoke.test.js's assertGpuBackend (which only sees the engine backend):
// useGPU=true drives both the engine and the enhancer onto the GPU, and this
// asserts the enhancer half actually did — the whole point of LavaSR-on-GPU.
function assertEnhancerGpuBackend(t, stats) {
  if (!stats) {
    t.fail('enhancer/GPU: no response.stats returned')
    return
  }
  const dev = stats.enhancerBackendDevice
  const id = stats.enhancerBackendId
  console.log(
    `[enhancer/GPU] enhancerBackendDevice=${dev} enhancerBackendId=${id} (${backendIdToName(id)})`
  )
  t.not(dev, -1, 'enhancer was loaded (enhancerBackendDevice != -1)')
  if (!expectsGpu()) {
    t.is(dev, 0, `enhancer/${platform}: must be CPU (0) on platforms with no GPU wired in`)
    return
  }
  if (dev !== 1) {
    const msg =
      `enhancer/${platform}: expected GPU, got ${backendIdToName(id)} ` +
      `(enhancerBackendDevice=${dev}, enhancerBackendId=${id}). useGPU=true was ` +
      'requested but the LavaSR enhancer ran on the scalar CPU core.'
    if (RELAX) {
      t.comment(`WARNING (relaxed): ${msg}`)
      t.pass('enhancer GPU (relaxed)')
    } else {
      t.fail(msg)
    }
    return
  }
  if (platform === 'darwin' || platform === 'ios') {
    t.is(id, 1, `enhancer/${platform}: expected Metal backendId=1, got ${backendIdToName(id)}`)
  } else if (platform === 'linux' || platform === 'win32') {
    t.is(id, 3, `enhancer/${platform}: expected Vulkan backendId=3, got ${backendIdToName(id)}`)
  } else if (platform === 'android') {
    t.ok(
      id === 3 || id === 4,
      `enhancer/${platform}: expected Vulkan(3)/OpenCL(4), got ${backendIdToName(id)}`
    )
  }
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

// ---- Construct-time regression tests (no models, always run) ----

test('Chatterbox: enhancer + streamChunkTokens constructs and forwards both', (t) => {
  // Previously rejected; streaming enhancement is now supported, so this must
  // construct and forward both knobs to the addon (which runs the streaming
  // enhancer per chunk).
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_CHATTERBOX,
    files: {
      t3Model: './models/chatterbox-t3-turbo.gguf',
      s3genModel: './models/chatterbox-s3gen.gguf',
      lavasrEnhancer: './models/lavasr/lavasr-enhancer.gguf'
    },
    streamChunkTokens: 25,
    config: { language: 'en' }
  })
  const params = model._buildTtsParams()
  t.is(params.streamChunkTokens, 25, 'streamChunkTokens forwarded')
  t.is(
    params.lavasrEnhancerPath,
    './models/lavasr/lavasr-enhancer.gguf',
    'enhancer path forwarded alongside streamChunkTokens'
  )
})

test('enhancer with an unknown type is rejected at construction', (t) => {
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_SUPERTONIC,
        files: {
          supertonicModel: './models/supertonic.gguf',
          lavasrEnhancer: './models/lavasr/lavasr-enhancer.gguf'
        },
        enhancer: { type: 'lavasr-typo' },
        config: { language: 'en' }
      }),
    /unknown enhancer\.type/,
    'a typo in enhancer.type throws instead of silently disabling enhancement'
  )
})

test('enhancer block with no GGUF path leaves enhancement off (no throw)', (t) => {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: './models/supertonic.gguf' },
    enhancer: { type: 'lavasr' },
    config: { language: 'en' }
  })
  t.absent(
    model._buildTtsParams().lavasrEnhancerPath,
    'no path resolved -> enhancement stays off (the path is the on switch)'
  )
})

// ---- GPU-switch wiring (no models, always run) ----
// The enhancer shares the engine's useGPU / nGpuLayers switch: the addon reads
// exactly these params and turns them into tts_cpp::lavasr::EnhancerOptions
// (use_gpu), which routes the ConvNeXt backbone + spec head onto a ggml GPU
// backend (Vulkan/Metal/CUDA/OpenCL). These pin that the JS layer forwards the
// switch alongside the enhancer path, for both engines.

for (const [engineName, engine, files] of [
  [
    'Supertonic',
    TTSGgml.ENGINE_SUPERTONIC,
    {
      supertonicModel: './models/supertonic.gguf',
      lavasrEnhancer: './models/lavasr/lavasr-enhancer.gguf'
    }
  ],
  [
    'Chatterbox',
    TTSGgml.ENGINE_CHATTERBOX,
    {
      t3Model: './models/chatterbox-t3-turbo.gguf',
      s3genModel: './models/chatterbox-s3gen.gguf',
      lavasrEnhancer: './models/lavasr/lavasr-enhancer.gguf'
    }
  ]
]) {
  test(`${engineName}: enhancer + useGPU:true forwards useGPU alongside the enhancer path`, (t) => {
    const model = new TTSGgml({ engine, files, config: { language: 'en', useGPU: true } })
    const params = model._buildTtsParams()
    t.is(params.useGPU, true, 'useGPU:true forwarded to the addon (drives EnhancerOptions.use_gpu)')
    t.is(
      params.lavasrEnhancerPath,
      './models/lavasr/lavasr-enhancer.gguf',
      'enhancer path forwarded'
    )
  })

  test(`${engineName}: enhancer + useGPU:false keeps the enhancer on CPU`, (t) => {
    const model = new TTSGgml({ engine, files, config: { language: 'en', useGPU: false } })
    const params = model._buildTtsParams()
    t.is(
      params.useGPU,
      false,
      'useGPU:false forwarded (enhancer runs on the ggml-CPU backend, reported as CPU)'
    )
    t.is(
      params.lavasrEnhancerPath,
      './models/lavasr/lavasr-enhancer.gguf',
      'enhancer path forwarded'
    )
  })

  test(`${engineName}: enhancer + nGpuLayers!=0 forwards the GPU layer count`, (t) => {
    const model = new TTSGgml({ engine, files, nGpuLayers: 99, config: { language: 'en' } })
    const params = model._buildTtsParams()
    t.is(params.nGpuLayers, 99, 'nGpuLayers forwarded (non-zero => enhancer requests the GPU)')
    t.is(
      params.lavasrEnhancerPath,
      './models/lavasr/lavasr-enhancer.gguf',
      'enhancer path forwarded'
    )
  })
}

// ---- Model-backed tests (gated on staged models) ----

test(
  'Supertonic + LavaSR enhancer reports 48 kHz enhanced output',
  { timeout: 600000 },
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
    const dl = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
    if (!dl.success) {
      t.fail('Supertonic GGUF not available — registry fetch failed.')
      return
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_SUPERTONIC,
      files: { supertonicModel: dl.path, lavasrEnhancer: enh.path },
      voice: 'F1',
      config: { language: 'en', useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const r = await runAndCollect(
        model,
        'LavaSR neural enhancement upsamples this to forty-eight kilohertz.'
      )
      t.is(r.sampleRate, 48000, 'enhanced supertonic output reports 48 kHz')
      t.ok(r.samples > 0, 'enhanced synthesis produced audio')
      // useGPU:false -> the enhancer runs on the ggml-CPU backend (a CPU device),
      // and the enhancer-specific backend stat must reflect that (0 = CPU, not
      // -1 = unset; and not 1 = GPU).  The model was constructed with stats:true,
      // so a missing stats object is itself a regression: assert it loudly instead
      // of guarding (a guard would let a stats regression pass silently).
      t.ok(r.stats, 'runtimeStats returned (constructed with stats:true)')
      t.is(
        r.stats.enhancerBackendDevice,
        0,
        'useGPU:false -> enhancer on CPU (enhancerBackendDevice=0)'
      )
      t.is(r.stats.enhancerBackendId, 0, 'useGPU:false -> enhancer backendId=0 (CPU)')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'Supertonic without enhancer reports native 44.1 kHz (backward compat)',
  { timeout: 600000 },
  async (t) => {
    const baseDir = getBaseDir()
    const dl = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
    if (!dl.success) {
      t.fail('Supertonic GGUF not available — registry fetch failed.')
      return
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_SUPERTONIC,
      files: { supertonicModel: dl.path },
      voice: 'F1',
      config: { language: 'en', useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const r = await runAndCollect(model, 'No enhancement here, just the native engine output.')
      t.is(r.sampleRate, 44100, 'un-enhanced supertonic reports 44.1 kHz')
      t.ok(r.samples > 0, 'synthesis produced audio')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'Chatterbox + LavaSR enhancer (batch) reports 48 kHz enhanced output',
  { timeout: 900000 },
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
    const modelsDir = path.join(baseDir, 'models')
    const dl = await ensureChatterboxModels({ targetDir: modelsDir })
    if (!dl.success) {
      t.fail('Chatterbox GGUFs not available — registry fetch failed.')
      return
    }
    const dir = dl.targetDir || modelsDir

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_CHATTERBOX,
      files: {
        modelDir: dir,
        t3Model: path.join(dir, 'chatterbox-t3-turbo.gguf'),
        s3genModel: path.join(dir, 'chatterbox-s3gen.gguf'),
        lavasrEnhancer: enh.path
      },
      referenceAudio: resolveRefWavPath({}),
      config: { language: 'en', useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const r = await runAndCollect(
        model,
        'Chatterbox output neurally upsampled to forty-eight kilohertz.'
      )
      t.is(r.sampleRate, 48000, 'enhanced chatterbox output reports 48 kHz')
      t.ok(r.samples > 0, 'enhanced synthesis produced audio')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'Chatterbox + LavaSR enhancer + native chunk streaming emits 48 kHz chunks',
  { timeout: 900000 },
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
    const modelsDir = path.join(baseDir, 'models')
    const dl = await ensureChatterboxModels({ targetDir: modelsDir })
    if (!dl.success) {
      t.fail('Chatterbox GGUFs not available — registry fetch failed.')
      return
    }
    const dir = dl.targetDir || modelsDir

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_CHATTERBOX,
      files: {
        modelDir: dir,
        t3Model: path.join(dir, 'chatterbox-t3-turbo.gguf'),
        s3genModel: path.join(dir, 'chatterbox-s3gen.gguf'),
        lavasrEnhancer: enh.path
      },
      referenceAudio: resolveRefWavPath({}),
      streamChunkTokens: 25, // native chunk streaming + enhancer (the path)
      config: { language: 'en', useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const updates = []
      const response = await model.run({
        input:
          'Streaming Chatterbox audio, neurally upsampled to forty-eight kilohertz, one chunk at a time.',
        type: 'text'
      })
      await response
        .onUpdate((d) => {
          if (d && d.outputArray) updates.push(d)
        })
        .await()

      const total = updates.reduce((acc, u) => acc + u.outputArray.length, 0)
      t.ok(updates.length >= 1, 'streamed at least one chunk event')
      t.ok(total > 0, 'streamed enhanced audio produced samples')
      // Every chunk that carries audio must be tagged at the enhanced 48 kHz rate
      // (not the engine's native 24 kHz) — the mislabel this feature prevents.
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

// ---- GPU-backed enhancer tests (gated on staged GGUF + a real GPU) ----
// These are the end-to-end counterpart to the C++ ggml-vs-scalar parity test
// (test-lavasr-enhancer-ggml, which strictly proves the Vulkan/Metal forward
// matches the scalar oracle numerically): here we drive the whole
// JS -> addon -> tts-cpp -> ggml GPU enhancer path with useGPU:true and assert
// (a) the output is still a valid 48 kHz signal and (b) the enhancer network
// actually ran on the GPU (enhancerBackendDevice/Id from runtimeStats). They
// skip on NO_GPU=true (CPU-only CI) and when the enhancer GGUF isn't staged.

test(
  'Supertonic + LavaSR enhancer on GPU (useGPU:true) runs the enhancer on the GPU and reports 48 kHz',
  { timeout: 600000, skip: NO_GPU },
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
    const dl = await ensureSupertonicModel({ targetDir: path.join(baseDir, 'models') })
    if (!dl.success) {
      t.fail('Supertonic GGUF not available — registry fetch failed.')
      return
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_SUPERTONIC,
      files: { supertonicModel: dl.path, lavasrEnhancer: enh.path },
      voice: 'F1',
      config: { language: 'en', useGPU: true },
      opts: { stats: true }
    })
    await model.load()
    try {
      const r = await runAndCollect(
        model,
        'LavaSR neural enhancement, running on the GPU, upsamples this to forty-eight kilohertz.'
      )
      t.is(r.sampleRate, 48000, 'GPU-enhanced supertonic output reports 48 kHz')
      t.ok(r.samples > 0, 'GPU-enhanced synthesis produced audio')
      assertEnhancerGpuBackend(t, r.stats)
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'Chatterbox + LavaSR enhancer on GPU (useGPU:true, batch) runs the enhancer on the GPU and reports 48 kHz',
  { timeout: 900000, skip: NO_GPU },
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
    const modelsDir = path.join(baseDir, 'models')
    const dl = await ensureChatterboxModels({ targetDir: modelsDir })
    if (!dl.success) {
      t.fail('Chatterbox GGUFs not available — registry fetch failed.')
      return
    }
    const dir = dl.targetDir || modelsDir

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_CHATTERBOX,
      files: {
        modelDir: dir,
        t3Model: path.join(dir, 'chatterbox-t3-turbo.gguf'),
        s3genModel: path.join(dir, 'chatterbox-s3gen.gguf'),
        lavasrEnhancer: enh.path
      },
      referenceAudio: resolveRefWavPath({}),
      config: { language: 'en', useGPU: true },
      opts: { stats: true }
    })
    await model.load()
    try {
      const r = await runAndCollect(
        model,
        'Chatterbox output neurally upsampled on the GPU to forty-eight kilohertz.'
      )
      t.is(r.sampleRate, 48000, 'GPU-enhanced chatterbox output reports 48 kHz')
      t.ok(r.samples > 0, 'GPU-enhanced synthesis produced audio')
      assertEnhancerGpuBackend(t, r.stats)
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)
