import test from 'brittle'
import {
  sdcppConfigSchema,
  worldSceneRequestSchema,
  worldStepRequestSchema
} from '@/schemas/sdcpp-config'

test('sdcppConfigSchema: accepts a world session config', (t) => {
  const parsed = sdcppConfigSchema.safeParse({
    mode: 'world',
    taehvModelSrc: 'registry://hf/taew2_2_f16.gguf',
    t5XxlModelSrc: 'registry://hf/umt5-xxl-enc-q8_0.gguf',
    vaeModelSrc: 'registry://hf/wan2.2_vae_f16.gguf',
    sceneSrc: '/worlds/forest.safetensors',
    world: {
      seed: 42,
      kvCache: true,
      localAttnSize: 8,
      numFramePerBlock: 3,
      frameJpegQuality: 85,
      offloadParamsToCpu: false,
      profile: true,
      threads: -1,
      backend: 'diffusion=cuda0,vae=cuda1'
    }
  })

  t.ok(parsed.success, 'full world config parses')
})

test('sdcppConfigSchema: the world block is strict', (t) => {
  // Unknown keys are silently ignored by the native config handler, so a typo
  // would otherwise disable the knob with no diagnostic at all.
  const parsed = sdcppConfigSchema.safeParse({
    mode: 'world',
    world: { kvcache: true }
  })

  t.absent(parsed.success, 'a mistyped world key is rejected rather than dropped')
})

test('sdcppConfigSchema: frameJpegQuality stays on the 0..100 scale', (t) => {
  t.ok(
    sdcppConfigSchema.safeParse({ mode: 'world', world: { frameJpegQuality: 0 } }).success,
    '0 = PNG'
  )
  t.ok(
    sdcppConfigSchema.safeParse({ mode: 'world', world: { frameJpegQuality: 100 } }).success,
    '100'
  )
  t.absent(
    sdcppConfigSchema.safeParse({ mode: 'world', world: { frameJpegQuality: 101 } }).success,
    'above the JPEG scale'
  )
  t.absent(
    sdcppConfigSchema.safeParse({ mode: 'world', world: { frameJpegQuality: -1 } }).success,
    'below the JPEG scale'
  )
})

test('worldStepRequestSchema: keys are the eight documented walk keys', (t) => {
  t.ok(
    worldStepRequestSchema.safeParse({ modelId: 'm', keys: ['W', 'A', 'S', 'D'] }).success,
    'movement'
  )
  t.ok(
    worldStepRequestSchema.safeParse({ modelId: 'm', keys: ['I', 'J', 'K', 'L'] }).success,
    'camera'
  )
  t.ok(worldStepRequestSchema.safeParse({ modelId: 'm', keys: [] }).success, 'idle block')
  t.ok(worldStepRequestSchema.safeParse({ modelId: 'm' }).success, 'keys are optional')

  t.absent(worldStepRequestSchema.safeParse({ modelId: 'm', keys: ['Q'] }).success, 'unmapped key')
  // The wire form is canonical uppercase; the client helper folds case before
  // building the request, so a lowercase key here means something bypassed it.
  t.absent(worldStepRequestSchema.safeParse({ modelId: 'm', keys: ['w'] }).success, 'lowercase')
  t.absent(worldStepRequestSchema.safeParse({ keys: ['W'] }).success, 'modelId is required')
})

test('worldSceneRequestSchema: dimensions must be positive multiples of 32', (t) => {
  const base = { modelId: 'm', prompt: 'a path through a forest', image: 'aGVsbG8=' }

  t.ok(worldSceneRequestSchema.safeParse(base).success, 'dimensions are optional')
  t.ok(worldSceneRequestSchema.safeParse({ ...base, width: 832, height: 480 }).success, 'defaults')
  t.ok(
    worldSceneRequestSchema.safeParse({ ...base, width: 448, height: 256 }).success,
    'low-VRAM tier'
  )

  t.absent(
    worldSceneRequestSchema.safeParse({ ...base, width: 833 }).success,
    'not a multiple of 32'
  )
  t.absent(worldSceneRequestSchema.safeParse({ ...base, height: 0 }).success, 'zero height')
  t.absent(worldSceneRequestSchema.safeParse({ ...base, width: -832 }).success, 'negative width')
})

test('cancel: the world kind is reachable from the public broad-cancel schema', async (t) => {
  const { cancelRequestSchema } = await import('@/schemas/cancel')

  // schemas/cancel.ts requires this list to track the server-side RequestKind
  // union; a kind that exists on the server but not here cannot be cancelled.
  t.ok(
    cancelRequestSchema.safeParse({
      type: 'cancel',
      operation: 'broad',
      modelId: 'm',
      kind: 'world'
    }).success,
    "cancel({ modelId, kind: 'world' }) is accepted"
  )
})

test('worldSceneRequestSchema: prompt and image are required and non-empty', (t) => {
  t.absent(
    worldSceneRequestSchema.safeParse({ modelId: 'm', prompt: '', image: 'aGVsbG8=' }).success,
    'empty prompt'
  )
  t.absent(
    worldSceneRequestSchema.safeParse({ modelId: 'm', prompt: 'a scene', image: '' }).success,
    'empty image'
  )
  t.absent(
    worldSceneRequestSchema.safeParse({ modelId: 'm', prompt: 'a scene', image: 'not base64!' })
      .success,
    'image must be base64'
  )
})
