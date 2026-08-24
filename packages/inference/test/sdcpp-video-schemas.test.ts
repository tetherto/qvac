import test from 'brittle'
import {
  diffusionRequestSchema,
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

test("sdcppConfigSchema: accepts mode: 'video' and highNoiseDiffusionModelSrc", (t: BrittleT) => {
  const result = sdcppConfigSchema.safeParse({
    mode: 'video',
    offload_to_cpu: true,
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
    vae_auto_cpu_fallback: true,
    vae_auto_cpu_fallback_memory_ratio: 0.9
  })

  t.is(result.success, true)
  t.is(result.success && result.data.vae_auto_cpu_fallback, true)
  t.is(result.success && result.data.vae_auto_cpu_fallback_memory_ratio, 0.9)
  t.is(sdcppConfigSchema.safeParse({ vae_auto_cpu_fallback_memory_ratio: 0 }).success, false)
  t.is(sdcppConfigSchema.safeParse({ vae_auto_cpu_fallback_memory_ratio: 1.1 }).success, false)
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
    video_frames: 5
  })
  t.is(result.success, true)
})

test('videoRequestSchema: accepts temporal_tiling and LTX-shaped dims/frames', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'txt2vid',
    prompt: 'a claymation cat playing jazz',
    // LTX dims (multiples of 32) and frames (8*k + 1) are a subset of the
    // permissive wire checks (multiples of 16, 4*k + 1); the server validates
    // the exact LTX rules after resolving the loaded model's layout.
    width: 512,
    height: 320,
    video_frames: 121,
    temporal_tiling: true
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
    video_frames: 121
  }

  t.is(ltxVideoRequestSchema.safeParse(base).success, true)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, width: 528 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, height: 496 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, video_frames: 13 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, video_frames: 265 }).success, false)
})

test('ltxVideoRequestSchema: accepts the full Ingredients request', (t: BrittleT) => {
  const result = ltxVideoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'txt2vid',
    prompt: 'Reference sheet: an explorer. Generated video: the explorer walks through snow.',
    lora: '/models/ltx-2-ingredients.safetensors',
    lora_strength: 1.37,
    stg_scale: 1,
    stg_block: 29,
    reference_images: [PNG_B64],
    reference_attention_strength: 1,
    reference_downscale_factor: 1,
    width: 768,
    height: 448,
    video_frames: 121,
    scheduler: 'ltx2'
  })

  t.is(result.success, true)
})

test('ltxVideoRequestSchema: validates LoRA and STG fields', (t: BrittleT) => {
  const base = {
    modelId: 'model-1',
    mode: 'txt2vid' as const,
    prompt: 'an explorer',
    video_frames: 121
  }

  t.is(ltxVideoRequestSchema.safeParse({ ...base, lora: 'relative.safetensors' }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, lora_strength: 1 }).success, false)
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      lora: '/models/adapter.safetensors',
      lora_strength: -0.1
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      lora: '/models/adapter.safetensors',
      lora_strength: 10
    }).success,
    true
  )
  t.is(ltxVideoRequestSchema.safeParse({ ...base, stg_scale: 10.1 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, stg_block: -1 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, stg_block: 1.5 }).success, false)
})

test('ltxVideoRequestSchema: validates reference conditioning dependencies', (t: BrittleT) => {
  const base = {
    modelId: 'model-1',
    mode: 'txt2vid' as const,
    prompt: 'an explorer',
    lora: '/models/adapter.safetensors',
    video_frames: 121
  }

  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      lora: undefined,
      reference_images: [PNG_B64]
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      reference_images: [PNG_B64, PNG_B64]
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      reference_attention_strength: 0.5
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      reference_downscale_factor: 1
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      reference_images: [PNG_B64],
      reference_attention_strength: 1.1
    }).success,
    false
  )
  t.is(
    ltxVideoRequestSchema.safeParse({
      ...base,
      reference_images: [PNG_B64],
      reference_downscale_factor: 2
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
    reference_images: [PNG_B64]
  }

  t.is(ltxVideoRequestSchema.safeParse(base).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, video_frames: 97 }).success, false)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, video_frames: 121 }).success, true)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, video_frames: 257 }).success, true)
  t.is(ltxVideoRequestSchema.safeParse({ ...base, video_frames: 265 }).success, false)
})

test('videoRequestSchema: rejects reference conditioning on img2vid', (t: BrittleT) => {
  const base = {
    modelId: 'model-1',
    mode: 'img2vid' as const,
    prompt: 'animate this frame',
    init_image: PNG_B64
  }

  t.is(videoRequestSchema.safeParse({ ...base, reference_images: [PNG_B64] }).success, false)
  t.is(videoRequestSchema.safeParse({ ...base, reference_attention_strength: 1 }).success, false)
  t.is(videoRequestSchema.safeParse({ ...base, reference_downscale_factor: 1 }).success, false)
})

test('nonLtxVideoRequestSchema: rejects every LTX-only field', (t: BrittleT) => {
  const fields = [
    ['lora', '/models/adapter.safetensors'],
    ['lora_strength', 1],
    ['stg_scale', 1],
    ['stg_block', 29],
    ['reference_images', [PNG_B64]],
    ['reference_attention_strength', 1],
    ['reference_downscale_factor', 1]
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
    diffusion_fa: true,
    vae_tiling: true
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
    video_frames: 121,
    fps: 24,
    steps: 4,
    cfg_scale: 1.0,
    flow_shift: 5.0
  }

  t.is(singleExpertVideoRequestSchema.safeParse(base).success, true)
  t.is(singleExpertVideoRequestSchema.safeParse({ ...base, high_noise_steps: 8 }).success, false)
  t.is(
    singleExpertVideoRequestSchema.safeParse({ ...base, high_noise_sampler: 'euler' }).success,
    false
  )
  t.is(
    singleExpertVideoRequestSchema.safeParse({ ...base, high_noise_scheduler: 'simple' }).success,
    false
  )
  t.is(
    singleExpertVideoRequestSchema.safeParse({ ...base, high_noise_cfg_scale: 6.0 }).success,
    false
  )
  t.is(
    singleExpertVideoRequestSchema.safeParse({ ...base, high_noise_flow_shift: 5.0 }).success,
    false
  )
  t.is(singleExpertVideoRequestSchema.safeParse({ ...base, moe_boundary: 0.875 }).success, false)

  // The A14B path keeps every MoE field: only the single-expert refinement
  // rejects them.
  t.is(videoRequestSchema.safeParse({ ...base, high_noise_steps: 8 }).success, true)
})

test('singleExpertVideoRequestSchema: reports every offending MoE field at its own path', (t: BrittleT) => {
  const result = singleExpertVideoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'txt2vid',
    prompt: 'a fox',
    high_noise_steps: 8,
    moe_boundary: 0.875
  })

  t.is(result.success, false)
  const paths = result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
  t.alike(paths.sort(), ['high_noise_steps', 'moe_boundary'])
})

test('videoRequestSchema: accepts optional requestId', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    requestId: 'video-request-1',
    mode: 'txt2vid',
    prompt: 'a running fox',
    video_frames: 5
  })
  t.is(result.success, true)
})

test('videoRequestSchema: validates video_frames, fps, moe_boundary, and base64 inputs', (t: BrittleT) => {
  t.is(
    videoRequestSchema.safeParse({
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'a fox',
      video_frames: 6
    }).success,
    false,
    'video_frames must satisfy (4*k + 1)'
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
      moe_boundary: 2
    }).success,
    false,
    'moe_boundary must be in [0, 1]'
  )

  t.is(
    videoRequestSchema.safeParse({
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'a fox',
      control_frames: ['not valid base64!!!']
    }).success,
    false,
    'control_frames entries must be valid base64'
  )

  t.is(
    videoRequestSchema.safeParse({
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'a fox',
      control_frames: []
    }).success,
    false,
    'control_frames must reject empty arrays'
  )
})

test('videoRequestSchema: accepts img2vid with init_image', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'img2vid',
    prompt: 'the subject waves gently',
    init_image: PNG_B64,
    strength: 0.85,
    video_frames: 5
  })
  t.is(result.success, true)
})

test('videoRequestSchema: accepts LTX-2 img2vid (init_image + strength + temporal_tiling)', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'img2vid',
    prompt: 'the subject slowly turns and smiles',
    init_image: PNG_B64,
    strength: 0.85,
    width: 512,
    height: 320,
    video_frames: 121,
    temporal_tiling: true
  })
  t.is(result.success, true)
})

test('videoRequestSchema: rejects img2vid without init_image', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'img2vid',
    prompt: 'animate this frame'
  })
  t.is(result.success, false)
})

test('videoRequestSchema: rejects txt2vid with init_image', (t: BrittleT) => {
  const result = videoRequestSchema.safeParse({
    modelId: 'model-1',
    mode: 'txt2vid',
    prompt: 'a fox',
    init_image: PNG_B64
  })
  t.is(result.success, false)
})

test('videoStreamRequestSchema: accepts img2vid stream envelope', (t: BrittleT) => {
  const result = videoStreamRequestSchema.safeParse({
    type: 'videoStream',
    modelId: 'model-1',
    mode: 'img2vid',
    prompt: 'animate this frame',
    init_image: PNG_B64
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
