'use strict'

// LavaSR enhancer integration + regression tests.
//
// The construct-time tests need no models and always run in CI. They pin:
// enhancer + native chunk streaming is now supported on Chatterbox, Parler and
// CosyVoice3 (constructs and forwards both knobs — the addon enhances each
// chunk seam-free), the denoiser stays batch-only, and a misconfigured enhancer
// can't silently become a no-op (an unknown enhancer.type throws). The
// model-backed tests assert the enhanced output is reported as 48 kHz for
// Supertonic, Chatterbox and Parler, covering the native chunk streaming of the
// latter two; they are gated on the converted enhancer GGUF being staged, and
// skip cleanly otherwise. CosyVoice3's model-backed coverage lives in
// cosyvoice3-lavasr.test.js, which the mobile suite shards onto the only row
// that stages the CosyVoice3 model.
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
  ensureLavaSRDenoiserGguf,
  ensureSupertonicModel,
  ensureChatterboxModels,
  ensureParlerModel
} = require('../utils/downloadModel')
const { resolveRefWavPath } = require('../utils/runChatterboxTTS')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
// Mirrors gpu-smoke.test.js: CI runners without a real GPU export NO_GPU=true to
// skip the GPU-gated entries; QVAC_TTS_GPU_SMOKE_RELAX=1 downgrades a GPU->CPU
// fallback from a failure to a warning (e.g. a Linux host with no Vulkan SDK).
const NO_GPU = proc.env && proc.env.NO_GPU === 'true'
const RELAX = proc.env && proc.env.QVAC_TTS_GPU_SMOKE_RELAX === '1'

const ENHANCED_RATE = 48000
const PARLER_NATIVE_RATE = 44100
// A rate that is neither Parler's native 44.1 kHz nor the enhancer's 48 kHz, so
// a chunk tagged with either would fail instead of coincidentally matching.
const REQUESTED_STREAM_RATE = 24000
const DURATION_TOLERANCE_MS = 1

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

// Every chunk that carries audio must be tagged at the enhanced 48 kHz rate
// rather than the engine's native rate — the mislabel this feature prevents.
function assertStreamedChunksReportEnhancedRate(t, updates) {
  assertStreamedChunkRate(t, updates, ENHANCED_RATE)
}

function assertStreamedChunkRate(t, updates, expectedRate) {
  for (const u of updates) {
    if (u.outputArray.length > 0 && u.sampleRate != null) {
      t.is(u.sampleRate, expectedRate, `streamed chunk reports ${expectedRate} Hz`)
    }
  }
}

// While streaming, the engine's SynthesisResult still reports the native rate
// and the un-enhanced sample count, so the addon has to tally what it actually
// emitted. Stats read off the engine instead would under-count the samples and
// mis-scale the duration.
function assertStreamedStatsMatchEmittedAudio(
  t,
  stats,
  emittedSamples,
  expectedRate = ENHANCED_RATE
) {
  t.ok(stats, 'runtimeStats returned (constructed with stats:true)')
  t.is(stats.totalSamples, emittedSamples, 'totalSamples counts emitted samples')
  const expectedMs = (emittedSamples * 1000) / expectedRate
  t.ok(
    Math.abs(stats.audioDurationMs - expectedMs) < DURATION_TOLERANCE_MS,
    `audioDurationMs ${stats.audioDurationMs} matches ${expectedMs} at ${expectedRate} Hz`
  )
}

function assertStreamTerminatesOnce(t, updates, terminal) {
  const isLastCount = updates.filter((u) => u.isLast === true).length
  t.ok(isLastCount <= 1, 'at most one isLast=true across streamed chunks')
  t.ok(terminal !== undefined, 'awaiting the response resolves a terminal value')
  const terminalSamples = terminal && terminal.outputArray ? terminal.outputArray.length : 0
  t.is(terminalSamples, 0, 'streaming emits via onUpdate, so the terminal payload is empty')
}

async function runParlerBatch(files) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_PARLER,
    files,
    voice: 'Laura',
    config: { useGPU: false },
    opts: { stats: true }
  })
  await model.load()
  try {
    return await runAndCollect(model, 'Parler speech cleaned by the LavaSR denoiser.')
  } finally {
    try {
      await model.unload()
    } catch (_e) {}
  }
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

test('Parler: enhancer + streamChunkTokens constructs and forwards both', (t) => {
  // Parler used to reject the enhancer outright; it now enhances both the batch
  // path and native chunk streaming (seam-free via the streaming enhancer).
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_PARLER,
    files: {
      parlerModel: './models/parler-mini-v1-q8_0.gguf',
      lavasrEnhancer: './models/lavasr/lavasr-enhancer.gguf'
    },
    streamChunkTokens: 43,
    config: { language: 'en' }
  })
  const params = model._buildTtsParams()
  t.is(params.streamChunkTokens, 43, 'streamChunkTokens forwarded')
  t.is(
    params.lavasrEnhancerPath,
    './models/lavasr/lavasr-enhancer.gguf',
    'enhancer path forwarded alongside streamChunkTokens'
  )
})

test('Parler: denoiser forwards on the batch path and is rejected while streaming', (t) => {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_PARLER,
    files: {
      parlerModel: './models/parler-mini-v1-q8_0.gguf',
      lavasrDenoiser: './models/lavasr/lavasr-denoiser.gguf'
    },
    config: { language: 'en' }
  })
  t.is(
    model._buildTtsParams().lavasrDenoiserPath,
    './models/lavasr/lavasr-denoiser.gguf',
    'denoiser path forwarded on the batch path'
  )
  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_PARLER,
        files: {
          parlerModel: './models/parler-mini-v1-q8_0.gguf',
          lavasrDenoiser: './models/lavasr/lavasr-denoiser.gguf'
        },
        streamChunkTokens: 43,
        config: { language: 'en' }
      }),
    /denoiser is not yet supported with native chunk streaming/,
    'denoiser + native chunk streaming throws (streaming denoise is a follow-up)'
  )
})

test('CosyVoice3: enhancer + streamChunkTokens constructs and forwards both', (t) => {
  // CosyVoice3 used to reject the enhancer outright; it is now supported on the
  // batch path and on native chunk streaming, so both knobs must reach the
  // addon together.
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_COSYVOICE3,
    files: {
      cosyvoiceModelDir: './models/cosyvoice3',
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

test('CosyVoice3: denoiser is forwarded for batch but rejected with streaming', (t) => {
  const batch = new TTSGgml({
    engine: TTSGgml.ENGINE_COSYVOICE3,
    files: {
      cosyvoiceModelDir: './models/cosyvoice3',
      lavasrDenoiser: './models/lavasr/lavasr-denoiser.gguf'
    },
    config: { language: 'en' }
  })
  t.is(
    batch._buildTtsParams().lavasrDenoiserPath,
    './models/lavasr/lavasr-denoiser.gguf',
    'denoiser path forwarded on the batch path'
  )

  t.exception(
    () =>
      new TTSGgml({
        engine: TTSGgml.ENGINE_COSYVOICE3,
        files: {
          cosyvoiceModelDir: './models/cosyvoice3',
          lavasrDenoiser: './models/lavasr/lavasr-denoiser.gguf'
        },
        streamChunkTokens: 25,
        config: { language: 'en' }
      }),
    /denoiser is not yet supported with native chunk streaming/,
    'denoiser + native chunk streaming throws (unlike the enhancer)'
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
// switch alongside the enhancer path, for all four engines.

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
  ],
  [
    'Parler',
    TTSGgml.ENGINE_PARLER,
    {
      parlerModel: './models/parler-mini-v1-q8_0.gguf',
      lavasrEnhancer: './models/lavasr/lavasr-enhancer.gguf'
    }
  ],
  [
    'CosyVoice3',
    TTSGgml.ENGINE_COSYVOICE3,
    {
      cosyvoiceModelDir: './models/cosyvoice3',
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
      assertStreamedChunksReportEnhancedRate(t, updates)
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
  'Parler + LavaSR enhancer (batch) reports 48 kHz enhanced output',
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
    const dl = await ensureParlerModel({ targetDir: path.join(baseDir, 'models') })
    if (!dl.success) {
      t.fail('Parler GGUF not available — registry fetch failed.')
      return
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_PARLER,
      files: { parlerModel: dl.path, lavasrEnhancer: enh.path },
      voice: 'Laura',
      config: { useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const r = await runAndCollect(
        model,
        'Parler output neurally enhanced to forty-eight kilohertz.'
      )
      // Parler is natively 44.1 kHz, so this also pins that the enhancer's rate
      // wins over the engine's native rate all the way out to the JS handler.
      t.is(r.sampleRate, 48000, 'enhanced parler output reports 48 kHz')
      t.ok(r.samples > 0, 'enhanced synthesis produced audio')
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
  'Parler without enhancer reports native 44.1 kHz (backward compat)',
  { timeout: 900000 },
  async (t) => {
    const baseDir = getBaseDir()
    const dl = await ensureParlerModel({ targetDir: path.join(baseDir, 'models') })
    if (!dl.success) {
      t.fail('Parler GGUF not available — registry fetch failed.')
      return
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_PARLER,
      files: { parlerModel: dl.path },
      voice: 'Laura',
      config: { useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const r = await runAndCollect(model, 'No enhancement here, just the native engine output.')
      t.is(r.sampleRate, 44100, 'un-enhanced parler reports 44.1 kHz')
      t.ok(r.samples > 0, 'synthesis produced audio')
      t.ok(r.stats, 'runtimeStats returned (constructed with stats:true)')
      t.is(r.stats.enhancerBackendDevice, -1, 'no enhancer loaded -> enhancerBackendDevice=-1')
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'Parler + LavaSR enhancer + native chunk streaming emits 48 kHz chunks',
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
    const dl = await ensureParlerModel({ targetDir: path.join(baseDir, 'models') })
    if (!dl.success) {
      t.fail('Parler GGUF not available — registry fetch failed.')
      return
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_PARLER,
      files: { parlerModel: dl.path, lavasrEnhancer: enh.path },
      voice: 'Laura',
      streamChunkTokens: 43, // native chunk streaming + enhancer (the path)
      config: { useGPU: false },
      opts: { stats: true }
    })
    await model.load()
    try {
      const updates = []
      const response = await model.run({
        input:
          'Streaming Parler audio, neurally enhanced to forty-eight kilohertz, one chunk at a time.',
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
      assertStreamedChunksReportEnhancedRate(t, updates)
      assertStreamedStatsMatchEmittedAudio(t, response.stats, total)
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
  'Parler + LavaSR enhancer + streaming honours a non-native outputSampleRate',
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
    const dl = await ensureParlerModel({ targetDir: path.join(baseDir, 'models') })
    if (!dl.success) {
      t.fail('Parler GGUF not available — registry fetch failed.')
      return
    }

    const model = new TTSGgml({
      engine: TTSGgml.ENGINE_PARLER,
      files: { parlerModel: dl.path, lavasrEnhancer: enh.path },
      voice: 'Laura',
      streamChunkTokens: 43,
      config: { useGPU: false, outputSampleRate: REQUESTED_STREAM_RATE },
      opts: { stats: true }
    })
    await model.load()
    try {
      const updates = []
      const response = await model.run({
        input:
          'Streaming Parler audio, enhanced and resampled on the way out, one chunk at a time.',
        type: 'text'
      })
      const terminal = await response
        .onUpdate((d) => {
          if (d && d.outputArray) updates.push(d)
        })
        .await()

      const emitted = updates.reduce((acc, u) => acc + u.outputArray.length, 0)
      t.ok(updates.length >= 1, 'streamed at least one chunk event')
      t.ok(emitted > 0, 'streamed resampled audio produced samples')
      assertStreamedChunkRate(t, updates, REQUESTED_STREAM_RATE)
      assertStreamedStatsMatchEmittedAudio(t, response.stats, emitted, REQUESTED_STREAM_RATE)
      assertStreamTerminatesOnce(t, updates, terminal)
    } finally {
      try {
        await model.unload()
      } catch (_e) {}
    }
  }
)

test(
  'Parler + LavaSR denoiser (batch) preserves the rate alone and composes with the enhancer',
  { timeout: 900000 },
  async (t) => {
    const baseDir = getBaseDir()
    const den = await ensureLavaSRDenoiserGguf({
      targetDir: path.join(baseDir, 'models', 'lavasr')
    })
    if (!den.success) {
      t.comment('LavaSR denoiser GGUF not staged; skipping.')
      t.pass('skipped — no denoiser GGUF')
      return
    }
    const dl = await ensureParlerModel({ targetDir: path.join(baseDir, 'models') })
    if (!dl.success) {
      t.fail('Parler GGUF not available — registry fetch failed.')
      return
    }

    const denoisedOnly = await runParlerBatch({
      parlerModel: dl.path,
      lavasrDenoiser: den.path
    })
    // denoise() is rate-preserving, so the denoiser alone must not move Parler
    // off its native rate the way the enhancer does.
    t.is(denoisedOnly.sampleRate, PARLER_NATIVE_RATE, 'denoiser alone stays at 44.1 kHz')
    t.ok(denoisedOnly.samples > 0, 'denoised synthesis produced audio')
    t.is(
      denoisedOnly.stats.enhancerBackendDevice,
      -1,
      'denoiser alone loads no enhancer (enhancerBackendDevice=-1)'
    )

    const enh = await ensureLavaSREnhancerGguf({
      targetDir: path.join(baseDir, 'models', 'lavasr')
    })
    if (!enh.success) {
      t.comment('LavaSR enhancer GGUF not staged; skipping the combined stage.')
      return
    }

    const denoisedAndEnhanced = await runParlerBatch({
      parlerModel: dl.path,
      lavasrDenoiser: den.path,
      lavasrEnhancer: enh.path
    })
    // The denoiser runs first at the native rate and the enhancer then decides
    // the output rate, so both stages loading is observable as 48 kHz output.
    t.is(
      denoisedAndEnhanced.sampleRate,
      ENHANCED_RATE,
      'denoiser + enhancer reports the enhanced 48 kHz'
    )
    t.ok(denoisedAndEnhanced.samples > 0, 'denoised + enhanced synthesis produced audio')
    t.is(
      denoisedAndEnhanced.stats.enhancerBackendDevice,
      0,
      'useGPU:false -> enhancer on CPU (enhancerBackendDevice=0)'
    )
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
