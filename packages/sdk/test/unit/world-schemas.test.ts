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

// These bounds mirror the addon's WorldSessionHandlers.cpp exactly:
// parseAutoOrPositiveInt for threads, parseIntInRange(..., 0, 1 << 10) for the
// two block-shape knobs. Accepting a value the native side rejects means the
// caller finds out after the multi-gigabyte artifacts have been resolved.
test('sdcppConfigSchema: world threads is -1 or positive, as the addon parses it', (t) => {
  t.ok(sdcppConfigSchema.safeParse({ mode: 'world', world: { threads: -1 } }).success, 'auto')
  t.ok(sdcppConfigSchema.safeParse({ mode: 'world', world: { threads: 8 } }).success, 'positive')
  t.absent(
    sdcppConfigSchema.safeParse({ mode: 'world', world: { threads: 0 } }).success,
    'zero threads is not auto and not a thread count'
  )
  t.absent(
    sdcppConfigSchema.safeParse({ mode: 'world', world: { threads: -2 } }).success,
    'only -1 means auto'
  )
  t.absent(
    sdcppConfigSchema.safeParse({ mode: 'world', world: { threads: 1.5 } }).success,
    'fractional threads'
  )
})

test('sdcppConfigSchema: world block-shape knobs stop at the native 1024 ceiling', (t) => {
  for (const key of ['numFramePerBlock', 'localAttnSize'] as const) {
    t.ok(
      sdcppConfigSchema.safeParse({ mode: 'world', world: { [key]: 0 } }).success,
      `${key}: 0 = engine default`
    )
    t.ok(
      sdcppConfigSchema.safeParse({ mode: 'world', world: { [key]: 1024 } }).success,
      `${key}: the native maximum`
    )
    t.absent(
      sdcppConfigSchema.safeParse({ mode: 'world', world: { [key]: 1025 } }).success,
      `${key}: past the native maximum`
    )
    t.absent(
      sdcppConfigSchema.safeParse({ mode: 'world', world: { [key]: -1 } }).success,
      `${key}: negative`
    )
  }
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

// Neither the SDK nor the addon bounded these before: the addon checks only
// "positive multiple of 32", and the pack ceiling in ops/world.ts runs after
// native generation has already allocated and written, so it cannot prevent the
// OOM it is named for.
test('worldSceneRequestSchema: allocation inputs are bounded before native dispatch', (t) => {
  const base = { modelId: 'm', prompt: 'a path through a forest', image: 'aGVsbG8=' }

  t.ok(
    worldSceneRequestSchema.safeParse({ ...base, width: 1920, height: 1088 }).success,
    'the 1920x1088 pixel budget is inclusive'
  )
  t.absent(
    worldSceneRequestSchema.safeParse({ ...base, width: 1920, height: 1120 }).success,
    'one 32-row step over the pixel budget'
  )
  t.absent(
    worldSceneRequestSchema.safeParse({ ...base, width: 4128 }).success,
    'one 32-column step over the per-axis ceiling'
  )
  // Both axes are individually legal here; only the product catches it.
  t.absent(
    worldSceneRequestSchema.safeParse({ ...base, width: 4096, height: 4096 }).success,
    'legal axes, illegal area'
  )
})

/** Well-formed base64 decoding to exactly `bytes`, padding included. */
function base64OfBytes(bytes: number): string {
  const groups = Math.ceil(bytes / 3)
  const padding = groups * 3 - bytes
  return 'A'.repeat(groups * 4 - padding) + '='.repeat(padding)
}

test('base64DecodedBytes: reports the decoded length without allocating', async (t) => {
  const { base64DecodedBytes } = await import('@/schemas/sdcpp-config')

  t.is(base64DecodedBytes('aGVsbG8='), 5, '"hello" is 5 bytes with one pad')
  t.is(base64DecodedBytes('aGVsbG8h'), 6, '"hello!" is 6 bytes with no pad')
  t.is(base64DecodedBytes('aGVsbG8hIQ=='), 7, '"hello!!" is 7 bytes with two pads')
  t.is(base64DecodedBytes(''), 0, 'the empty string decodes to nothing')

  // Round-trips against the generator the boundary tests below rely on, so a
  // mistake in either shows up here rather than as a silently loose ceiling.
  t.is(base64DecodedBytes(base64OfBytes(1)), 1, 'one byte')
  t.is(base64DecodedBytes(base64OfBytes(3)), 3, 'a whole group')
  t.is(base64DecodedBytes(base64OfBytes(1_000_000)), 1_000_000, 'a large non-multiple of 3')
})

test('worldSceneRequestSchema: an oversized first frame is refused', async (t) => {
  const { MAX_SCENE_IMAGE_BYTES } = await import('@/schemas/sdcpp-config')
  const base = { modelId: 'm', prompt: 'a path through a forest' }

  t.ok(
    worldSceneRequestSchema.safeParse({ ...base, image: base64OfBytes(MAX_SCENE_IMAGE_BYTES) })
      .success,
    'exactly at the ceiling'
  )
  t.absent(
    worldSceneRequestSchema.safeParse({ ...base, image: base64OfBytes(MAX_SCENE_IMAGE_BYTES + 3) })
      .success,
    'three bytes over it'
  )
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
