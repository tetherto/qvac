import test from 'brittle'
import {
  ltxVideoRequestSchema,
  sdcppConfigSchema,
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

test('videoStatsSchema: accepts video runtime stats fields', (t: BrittleT) => {
  const result = videoStatsSchema.safeParse({
    modelLoadMs: 500,
    generationMs: 1234,
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
