import test from 'brittle'
import {
  sdcppConfigSchema,
  worldKeysSchema,
  worldSceneRequestSchema,
  worldSceneStreamResponseSchema,
  worldStepRequestSchema,
  worldStepStreamRequestSchema,
  worldStepStreamResponseSchema
} from '@/schemas'

type BrittleT = {
  alike: (actual: unknown, expected: unknown, msg?: string) => void
  is: (actual: unknown, expected: unknown, msg?: string) => void
  ok: (value: unknown, msg?: string) => void
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='

test("sdcppConfigSchema: accepts mode: 'world' with taehvModelSrc and the world block", (t: BrittleT) => {
  const result = sdcppConfigSchema.safeParse({
    mode: 'world',
    taehvModelSrc: 'taew2_2_f16.gguf',
    t5XxlModelSrc: 'umt5-xxl-enc-q8_0.gguf',
    vaeModelSrc: 'wan2.2_vae_f16.gguf',
    world: {
      scenePack: '/models/scene.safetensors',
      seed: 42,
      kv_cache: true,
      frame_jpeg_quality: 85
    }
  })
  t.is(result.success, true)
})

test('sdcppConfigSchema: world.scenePack must be an absolute path', (t: BrittleT) => {
  const result = sdcppConfigSchema.safeParse({
    mode: 'world',
    taehvModelSrc: 'taew2_2_f16.gguf',
    world: { scenePack: 'relative/scene.safetensors' }
  })
  t.is(result.success, false)
})

test('sdcppConfigSchema: world block rejects unknown keys and out-of-range quality', (t: BrittleT) => {
  t.is(
    sdcppConfigSchema.safeParse({
      mode: 'world',
      world: { scenePack: '/models/scene.safetensors', bogus: 1 }
    }).success,
    false
  )
  t.is(
    sdcppConfigSchema.safeParse({
      mode: 'world',
      world: { scenePack: '/models/scene.safetensors', frame_jpeg_quality: 101 }
    }).success,
    false
  )
})

test('worldKeysSchema: accepts key arrays and raw 8-bit masks, rejects out-of-range', (t: BrittleT) => {
  t.is(worldKeysSchema.safeParse(['W', 'L']).success, true)
  t.is(worldKeysSchema.safeParse([]).success, true)
  t.is(worldKeysSchema.safeParse(0).success, true)
  t.is(worldKeysSchema.safeParse(255).success, true)
  t.is(worldKeysSchema.safeParse(['X']).success, false)
  t.is(worldKeysSchema.safeParse(256).success, false)
  t.is(worldKeysSchema.safeParse(-1).success, false)
  t.is(worldKeysSchema.safeParse(1.5).success, false)
})

test('worldStepRequestSchema: modelId required, keys optional', (t: BrittleT) => {
  t.is(worldStepRequestSchema.safeParse({ modelId: 'm1' }).success, true)
  t.is(worldStepRequestSchema.safeParse({ modelId: 'm1', keys: ['W'] }).success, true)
  t.is(worldStepRequestSchema.safeParse({}).success, false)
})

test('worldStepStreamRequestSchema: requires the type literal', (t: BrittleT) => {
  t.is(
    worldStepStreamRequestSchema.safeParse({ type: 'worldStep', modelId: 'm1', keys: 3 }).success,
    true
  )
  t.is(worldStepStreamRequestSchema.safeParse({ type: 'videoStream', modelId: 'm1' }).success, false)
})

test('worldStepStreamResponseSchema: frame, progress, and terminal chunks parse', (t: BrittleT) => {
  t.is(
    worldStepStreamResponseSchema.safeParse({
      type: 'worldStep',
      data: PNG_B64,
      outputIndex: 0
    }).success,
    true
  )
  t.is(
    worldStepStreamResponseSchema.safeParse({
      type: 'worldStep',
      step: 3,
      frames: 12,
      elapsedMs: 1780
    }).success,
    true
  )
  const terminal = worldStepStreamResponseSchema.safeParse({
    type: 'worldStep',
    done: true,
    stats: { stepMs: 1780, totalSteps: 3, totalFrames: 33, width: 832, height: 480 }
  })
  t.is(terminal.success, true)
})

test('worldSceneRequestSchema: validates prompt, image, and 32-multiple dimensions', (t: BrittleT) => {
  t.is(
    worldSceneRequestSchema.safeParse({
      modelId: 'm1',
      prompt: 'a navigable path',
      image: PNG_B64,
      width: 832,
      height: 480
    }).success,
    true
  )
  t.is(
    worldSceneRequestSchema.safeParse({ modelId: 'm1', prompt: '', image: PNG_B64 }).success,
    false
  )
  t.is(
    worldSceneRequestSchema.safeParse({ modelId: 'm1', prompt: 'p', image: 'not base64!' }).success,
    false
  )
  t.is(
    worldSceneRequestSchema.safeParse({
      modelId: 'm1',
      prompt: 'p',
      image: PNG_B64,
      width: 830
    }).success,
    false
  )
})

test('worldSceneStreamResponseSchema: terminal chunk parses with scene stats', (t: BrittleT) => {
  t.is(
    worldSceneStreamResponseSchema.safeParse({
      type: 'worldCreateScene',
      done: true,
      stats: { sceneCreateMs: 2306, width: 832, height: 480 }
    }).success,
    true
  )
})
