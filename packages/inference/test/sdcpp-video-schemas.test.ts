import test from 'brittle'
import {
  diffusionRequestSchema,
  h3VideoRequestSchema,
  wanVideoRequestSchema,
  ltxVideoRequestSchema,
  nonLtxVideoRequestSchema,
  sdcppConfigSchema,
  singleExpertVideoRequestSchema,
  videoRequestSchema,
  videoStatsSchema,
  videoStreamRequestSchema,
  videoStreamResponseSchema
} from '@/schemas'

type BrittleT = {
  alike: (actual: unknown, expected: unknown, msg?: string) => void
  is: (actual: unknown, expected: unknown, msg?: string) => void
  ok: (value: unknown, msg?: string) => void
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='

test('video schemas: H3 envelopes and loaded-family frame rules', (t) => {
  const base = {
    modelId: 'h3',
    mode: 'txt2vid' as const,
    prompt: 'Steam rises from an espresso cup.'
  }
  for (const videoFrames of [5, 22, 39, 73, 124]) {
    t.ok(videoRequestSchema.safeParse({ ...base, videoFrames }).success)
    t.ok(videoStreamRequestSchema.safeParse({ ...base, type: 'videoStream', videoFrames }).success)
    t.ok(h3VideoRequestSchema.safeParse({ ...base, videoFrames }).success)
  }
  for (const videoFrames of [0, -1, 1.5]) {
    t.is(videoRequestSchema.safeParse({ ...base, videoFrames }).success, false)
    t.is(
      videoStreamRequestSchema.safeParse({ ...base, type: 'videoStream', videoFrames }).success,
      false
    )
  }
  for (const videoFrames of [1, 6, 17, 121]) {
    t.is(h3VideoRequestSchema.safeParse({ ...base, videoFrames }).success, false)
  }
  for (const videoFrames of [1, 6, 22, 124]) {
    t.is(wanVideoRequestSchema.safeParse({ ...base, videoFrames }).success, false)
  }
  for (const videoFrames of [1, 5, 22, 124, 265]) {
    t.is(ltxVideoRequestSchema.safeParse({ ...base, videoFrames }).success, false)
  }
  t.ok(wanVideoRequestSchema.safeParse({ ...base, videoFrames: 5 }).success)
  t.ok(ltxVideoRequestSchema.safeParse({ ...base, videoFrames: 9 }).success)
  t.ok(ltxVideoRequestSchema.safeParse({ ...base, videoFrames: 257 }).success)
  t.alike(h3VideoRequestSchema.parse(base), base, 'native generation defaults remain omitted')
})

test('H3 schema: validates fixed controls and unsupported conditioning', (t) => {
  const base = {
    modelId: 'h3',
    mode: 'txt2vid' as const,
    prompt: 'Steam rises from an espresso cup.'
  }
  t.ok(
    h3VideoRequestSchema.safeParse({
      ...base,
      width: 960,
      height: 544,
      fps: 24,
      cfgScale: 1,
      scheduler: 'discrete',
      steps: 8
    }).success
  )
  for (const params of [
    { width: 944 },
    { height: 528 },
    { fps: 16 },
    { cfgScale: 0 },
    { scheduler: 'simple' },
    { controlFrames: [PNG_B64] },
    { vaceStrength: 0 },
    { strength: 0 }
  ]) {
    t.is(
      h3VideoRequestSchema.safeParse({ ...base, ...params }).success,
      false,
      JSON.stringify(params)
    )
  }
})

test('H3 schema: accepts image keyframes only for img2vid', (t) => {
  const base = {
    modelId: 'h3',
    prompt: 'Animate the supplied first frame.',
    width: 864,
    height: 480,
    videoFrames: 22,
    fps: 24,
    cfgScale: 1
  }
  t.ok(h3VideoRequestSchema.safeParse({ ...base, mode: 'img2vid', initImage: PNG_B64 }).success)
  t.is(h3VideoRequestSchema.safeParse({ ...base, mode: 'img2vid' }).success, false)
  t.is(
    h3VideoRequestSchema.safeParse({ ...base, mode: 'txt2vid', initImage: PNG_B64 }).success,
    false
  )
  t.is(
    h3VideoRequestSchema.safeParse({ ...base, mode: 'img2vid', initImage: PNG_B64, strength: 0.8 })
      .success,
    false
  )
})

test('sdcpp config: preserves H3 backend and memory controls', (t) => {
  const config = {
    mode: 'video',
    backend: 'cuda0',
    paramsBackend: 'cpu',
    maxVram: 'cuda0=6,vulkan0=2',
    streamLayers: false
  }
  t.alike(sdcppConfigSchema.parse(config), config)
  t.is(sdcppConfigSchema.parse({ maxVram: 0 }).maxVram, 0)
  for (const config of [
    { backend: 0 },
    { paramsBackend: false },
    { maxVram: true },
    { streamLayers: 'false' }
  ]) {
    t.is(sdcppConfigSchema.safeParse(config).success, false)
  }
  const defaults = sdcppConfigSchema.parse({ mode: 'video' })
  for (const field of ['backend', 'paramsBackend', 'maxVram', 'streamLayers'] as const) {
    t.is(defaults[field], undefined)
  }
})

test("sdcppConfigSchema: accepts mode: 'video' and highNoiseDiffusionModelSrc", (t: BrittleT) => {
  const result = sdcppConfigSchema.safeParse({
    mode: 'video',
    offloadToCpu: true,
    t5XxlModelSrc: 'umt5_xxl_fp16.safetensors',
    vaeModelSrc: 'wan_2.1_vae.safetensors',
    highNoiseDiffusionModelSrc: 'wan2.2_high_noise_fp16.safetensors'
  })
  t.is(result.success, true)
})

test('sdcppConfigSchema: accepts clipVisionModelSrc for Wan img2vid pipelines', (t: BrittleT) => {
  const result = sdcppConfigSchema.safeParse({
    mode: 'video',
    t5XxlModelSrc: 'umt5_xxl_fp16.safetensors',
    vaeModelSrc: 'wan_2.1_vae.safetensors',
    clipVisionModelSrc: 'clip_vision_h.safetensors'
  })
  t.is(result.success, true)
})

test('sdcppConfigSchema: accepts LTX-2 video layout sources', (t: BrittleT) => {
  const result = sdcppConfigSchema.safeParse({
    mode: 'video',
    llmModelSrc: 'gemma-3-12b-it.gguf',
    vaeModelSrc: 'ltx-2.3-22b_video_vae.safetensors',
    audioVaeModelSrc: 'ltx-2.3-22b_audio_vae.safetensors',
    embeddingsConnectorsModelSrc: 'ltx-2.3-22b_embeddings_connectors.safetensors'
  })
  t.is(result.success, true)
})

test('sdcppConfigSchema: preserves automatic VAE CPU fallback settings', (t: BrittleT) => {
  const result = sdcppConfigSchema.safeParse({
    mode: 'video',
    vaeAutoCpuFallback: true,
    vaeAutoCpuFallbackMemoryRatio: 0.9
  })

  t.is(result.success, true)
  t.is(result.success && result.data.vaeAutoCpuFallback, true)
  t.is(result.success && result.data.vaeAutoCpuFallbackMemoryRatio, 0.9)
  t.is(sdcppConfigSchema.safeParse({ vaeAutoCpuFallbackMemoryRatio: 0 }).success, false)
  t.is(sdcppConfigSchema.safeParse({ vaeAutoCpuFallbackMemoryRatio: 1.1 }).success, false)
})

test('videoStatsSchema: accepts video runtime stats fields', (t: BrittleT) => {
  const result = videoStatsSchema.safeParse({
    modelLoadMs: 500,
    generationMs: 1234,
    conditionerMs: 100,
    denoiseMs: 800,
    vaeMs: 200,
    postProcessMs: 134,
    stepsPerSecond: 25,
    totalGenerationMs: 1234,
    totalWallMs: 1734,
    totalSteps: 20,
    totalGenerations: 1,
    totalImages: 1,
    totalPixels: 262144,
    totalVideos: 1,
    totalVideoFrames: 5,
    width: 512,
    height: 512,
    seed: 42,
    videoFrames: 5,
    fps: 16
  })
  t.is(result.success, true)
})

test('videoStatsSchema: preserves LTX-2 audio stats through parse', (t: BrittleT) => {
  // These come straight off the addon's VideoRuntimeStats; the schema must not
  // strip them, otherwise consumers awaiting `video(...).stats` never see
  // whether audio was muxed into the output AVI.
  const result = videoStatsSchema.safeParse({
    generationMs: 1234,
    totalVideos: 1,
    videoFrames: 121,
    fps: 24,
    hasAudio: true,
    audioSampleRate: 48000
  })
  t.is(result.success, true)
  t.is(result.success && result.data.hasAudio, true)
  t.is(result.success && result.data.audioSampleRate, 48000)
})

test('videoRequestSchema: accepts minimal txt2vid request', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'txt2vid',
    prompt: 'a running fox',
    videoFrames: 5
  })
  t.is(result.success, true)
})

test('videoRequestSchema: accepts temporalTiling and LTX-shaped dims/frames', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'txt2vid',
    prompt: 'a claymation cat playing jazz',
    // The server validates family-specific rules against the loaded model.
    width: 512,
    height: 320,
    videoFrames: 121,
    temporalTiling: true
  })
  t.is(result.success, true)
})

test('ltxVideoRequestSchema: enforces LTX-2 dimensions and frame counts', (t: BrittleT) => {
  const base = {
    modelId: 'model-1',
    mode: 'txt2vid' as const,
    prompt: 'a claymation cat playing jazz',
    width: 512,
    height: 320,
    videoFrames: 121
  }

  t.is(ltxVideoRequestSchema.safeParse(base).success, true)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, width: 528 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, height: 496 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, videoFrames: 13 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, videoFrames: 265 }).success, false)
})

test('ltxVideoRequestSchema: accepts the full Ingredients request', (t: BrittleT) => {
  const result = ltxVideoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'txt2vid',
    prompt: 'Reference sheet: an explorer. Generated video: the explorer walks through snow.',
    lora: '/models/ltx-2-ingredients.safetensors',
    loraStrength: 1.37,
    stgScale: 1,
    stgBlock: 29,
    referenceImages: [PNG_B64],
    referenceAttentionStrength: 1,
    referenceDownscaleFactor: 1,
    width: 768,
    height: 448,
    videoFrames: 121,
    scheduler: 'ltx2'
  })

  t.is(result.success, true)
})

test('ltxVideoRequestSchema: validates LoRA and STG fields', (t: BrittleT) => {
  const base = {
    modelId: 'model-1',
    mode: 'txt2vid' as const,
    prompt: 'an explorer',
    videoFrames: 121
  }

  t.is(ltxVideoRequestSchema.safeParse({ ...base, lora: 'relative.safetensors' }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, loraStrength: 1 }).success, false)
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      lora: '/models/adapter.safetensors',
      loraStrength: -0.1
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      lora: '/models/adapter.safetensors',
      loraStrength: 10
    }).success,
    true
  )
  t.is(ltxVideoRequestSchema.safeParse({ ...base, stgScale: 10.1 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, stgBlock: -1 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, stgBlock: 1.5 }).success, false)
})

test('ltxVideoRequestSchema: validates reference conditioning dependencies', (t: BrittleT) => {
  const base = {
    modelId: 'model-1',
    mode: 'txt2vid' as const,
    prompt: 'an explorer',
    lora: '/models/adapter.safetensors',
    videoFrames: 121
  }

  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      lora: undefined,
      referenceImages: [PNG_B64]
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      referenceImages: [PNG_B64, PNG_B64]
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      referenceAttentionStrength: 0.5
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      referenceDownscaleFactor: 1
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      referenceImages: [PNG_B64],
      referenceAttentionStrength: 1.1
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      referenceImages: [PNG_B64],
      referenceDownscaleFactor: 2
    }).success,
    false
  )
})

test('ltxVideoRequestSchema: reference conditioning requires at least 121 frames', (t: BrittleT) => {
  const base = {
    modelId: 'model-1',
    mode: 'txt2vid' as const,
    prompt: 'an explorer',
    lora: '/models/adapter.safetensors',
    referenceImages: [PNG_B64]
  }

  t.is(ltxVideoRequestSchema.safeParse(base).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, videoFrames: 97 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, videoFrames: 121 }).success, true)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, videoFrames: 257 }).success, true)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, videoFrames: 265 }).success, false)
})

test('videoRequestSchema: rejects reference conditioning on img2vid', (t: BrittleT) => {
  const base = {
    modelId: 'model-1',
    mode: 'img2vid' as const,
    prompt: 'animate this frame',
    initImage: PNG_B64
  }

  t.is(videoRequestSchema.safeParse({ ...base, referenceImages: [PNG_B64] }).success, false)
  t.is(videoRequestSchema.safeParse({ ...base, referenceAttentionStrength: 1 }).success, false)
  t.is(videoRequestSchema.safeParse({ ...base, referenceDownscaleFactor: 1 }).success, false)
})

test('nonLtxVideoRequestSchema: rejects every LTX-only field', (t: BrittleT) => {
  const fields = [
    ['lora', '/models/adapter.safetensors'],
    ['loraStrength', 1],
    ['stgScale', 1],
    ['stgBlock', 29],
    ['referenceImages', [PNG_B64]],
    ['referenceAttentionStrength', 1],
    ['referenceDownscaleFactor', 1]
  ] as const

  for (const [field, value] of fields) {
    t.is(
      nonLtxVideoRequestSchema.safeParse({ [field]: value }).success,
      false,
      `${field} is rejected`
    )
  }
  t.is(nonLtxVideoRequestSchema.safeParse({ scheduler: 'ltx2' }).success, false)
  t.is(nonLtxVideoRequestSchema.safeParse({ scheduler: 'simple' }).success, true)
})

test("diffusionRequestSchema: does not widen image scheduler to 'ltx2'", (t: BrittleT) => {
  const result = diffusionRequestSchema.safeParse({
    modelId: 'model-1',
    prompt: 'an explorer',
    scheduler: 'ltx2'
  })

  t.is(result.success, false)
})

test('sdcppConfigSchema: accepts the Wan 2.2 TI2V-5B three-file layout', (t: BrittleT) => {
  const result = sdcppConfigSchema.safeParse({
    mode: 'video',
    t5XxlModelSrc: 'umt5_xxl_fp16.safetensors',
    vaeModelSrc: 'wan2.2_vae.safetensors',
    diffusionFlashAttention: true,
    vaeTiling: true
  })
  t.is(result.success, true)
})

test('singleExpertVideoRequestSchema: rejects MoE fields without a high-noise expert', (t: BrittleT) => {
  // The Wan 2.2 TI2V-5B Turbo shape: 32-pixel grid, (4*k + 1) frames.
  const base = {
    modelId: 'model-1',
    mode: 'txt2vid' as const,
    prompt: 'steam curling from an espresso cup',
    width: 1280,
    height: 704,
    videoFrames: 121,
    fps: 24,
    steps: 4,
    cfgScale: 1.0,
    flowShift: 5.0
  }

  t.is(singleExpertVideoRequestSchema.safeParse(base).success, true)
  t.is(singleExpertVideoRequestSchema.safeParse({ ...base, highNoiseSteps: 8 }).success, false)
  t.is(
    singleExpertVideoRequestSchema.safeParse({ ...base, highNoiseSampler: 'euler' }).success,
    false
  )
  t.is(
    singleExpertVideoRequestSchema.safeParse({ ...base, highNoiseScheduler: 'simple' }).success,
    false
  )
  t.is(singleExpertVideoRequestSchema.safeParse({ ...base, highNoiseCfgScale: 6.0 }).success, false)
  t.is(
    singleExpertVideoRequestSchema.safeParse({ ...base, highNoiseFlowShift: 5.0 }).success,
    false
  )
  t.is(singleExpertVideoRequestSchema.safeParse({ ...base, moeBoundary: 0.875 }).success, false)

  // The A14B path keeps every MoE field: only the single-expert refinement
  // rejects them.
  t.is(videoRequestSchema.safeParse({ ...base, highNoiseSteps: 8 }).success, true)
})

test('singleExpertVideoRequestSchema: reports every offending MoE field at its own path', (t: BrittleT) => {
  const result = singleExpertVideoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'txt2vid',
    prompt: 'a fox',
    highNoiseSteps: 8,
    moeBoundary: 0.875
  })

  t.is(result.success, false)
  const paths = result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
  t.alike(paths.sort(), ['highNoiseSteps', 'moeBoundary'])
})

test('videoRequestSchema: accepts optional requestId', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    requestId: 'video-request-1',
    mode: 'txt2vid',
    prompt: 'a running fox',
    videoFrames: 5
  })
  t.is(result.success, true)
})

test('videoRequestSchema: validates videoFrames, fps, moeBoundary, and base64 inputs', (t: BrittleT) => {
  t.is(
    wanVideoRequestSchema.safeParse({
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'a fox',
      videoFrames: 6
    }).success,
    false,
    'videoFrames must satisfy (4*k + 1)'
  )

  t.is(
    videoRequestSchema.safeParse({
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'a fox',
      fps: 0
    }).success,
    false,
    'fps must be > 0'
  )

  t.is(
    videoRequestSchema.safeParse({
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'a fox',
      moeBoundary: 2
    }).success,
    false,
    'moeBoundary must be in [0, 1]'
  )

  t.is(
    videoRequestSchema.safeParse({
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'a fox',
      controlFrames: ['not valid base64!!!']
    }).success,
    false,
    'controlFrames entries must be valid base64'
  )

  t.is(
    videoRequestSchema.safeParse({
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'a fox',
      controlFrames: []
    }).success,
    false,
    'controlFrames must reject empty arrays'
  )
})

test('videoRequestSchema: accepts img2vid with initImage', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'img2vid',
    prompt: 'the subject waves gently',
    initImage: PNG_B64,
    strength: 0.85,
    videoFrames: 5
  })
  t.is(result.success, true)
})

test('videoRequestSchema: accepts LTX-2 img2vid (initImage + strength + temporalTiling)', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'img2vid',
    prompt: 'the subject slowly turns and smiles',
    initImage: PNG_B64,
    strength: 0.85,
    width: 512,
    height: 320,
    videoFrames: 121,
    temporalTiling: true
  })
  t.is(result.success, true)
})

test('videoRequestSchema: rejects img2vid without initImage', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'img2vid',
    prompt: 'animate this frame'
  })
  t.is(result.success, false)
})

test('videoRequestSchema: rejects txt2vid with initImage', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'txt2vid',
    prompt: 'a fox',
    initImage: PNG_B64
  })
  t.is(result.success, false)
})

test('videoStreamRequestSchema: accepts img2vid stream envelope', (t: BrittleT) => {
  const result = videoStreamRequestSchema.safeParse({
    type: 'videoStream',
    modelId: 'model-1',
    mode: 'img2vid',
    prompt: 'animate this frame',
    initImage: PNG_B64
  })
  t.is(result.success, true)
})

test('videoStreamResponseSchema: accepts progress, output, and final stats chunks', (t: BrittleT) => {
  t.is(
    videoStreamResponseSchema.safeParse({
      type: 'videoStream',
      step: 1,
      totalSteps: 5,
      elapsedMs: 200
    }).success,
    true
  )

  t.is(
    videoStreamResponseSchema.safeParse({
      type: 'videoStream',
      data: PNG_B64,
      outputIndex: 0
    }).success,
    true
  )

  t.is(
    videoStreamResponseSchema.safeParse({
      type: 'videoStream',
      done: true,
      stats: {
        generationMs: 1234,
        conditionerMs: 100,
        denoiseMs: 800,
        vaeMs: 200,
        postProcessMs: 134,
        stepsPerSecond: 25,
        totalVideos: 1,
        totalVideoFrames: 5,
        videoFrames: 5,
        fps: 16
      }
    }).success,
    true
  )

  const withAudio = videoStreamResponseSchema.safeParse({
    type: 'videoStream',
    done: true,
    stats: {
      generationMs: 1234,
      totalVideos: 1,
      videoFrames: 121,
      fps: 24,
      hasAudio: true,
      audioSampleRate: 48000
    }
  })
  t.is(withAudio.success, true)
  t.is(withAudio.success && withAudio.data.stats?.hasAudio, true)
  t.is(withAudio.success && withAudio.data.stats?.audioSampleRate, 48000)
})
