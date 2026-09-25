// ABot-World interactive world session test definitions.
//
// Runs at the 448x256 low-VRAM tier rather than the validated 832x480 one: the
// walk session needs ~20 GB free VRAM at 832x480, where 448x256 fits the ~6 GB
// class of card, so these can run on the shared GPU desktop runners. That makes
// this a correctness lane, not a performance one — block times here are far
// below interactive.
import type { Step, TestDefinition, TestResult } from '@qvac/test-suite'

type ExpectationLike =
  | { validation: 'type'; expectedType: 'string' | 'number' | 'array' }
  | { validation: 'throws-error'; errorContains: string }
  | { validation: 'function'; fn: (result: unknown) => TestResult }

type WorldTestOptions = {
  estimatedDurationMs?: number
  suites?: string[]
  /** 'world' pulls the 13.3 GB model set; client-side validation needs none. */
  dependency?: string
}

export type WorldTestDef<TId extends string, P extends Record<string, unknown>> = TestDefinition & {
  testId: TId
  params: P
}

function createWorldTest<const TId extends string, const P extends Record<string, unknown>>(
  testId: TId,
  params: P,
  expectation: ExpectationLike,
  options: WorldTestOptions = {}
): WorldTestDef<TId, P> {
  const { estimatedDurationMs = 600000, suites, dependency = 'world' } = options
  return {
    testId,
    params,
    expectation,
    ...(suites && { suites }),
    metadata: {
      category: 'world',
      // Deliberately its own dependency key: the ABot set is ~13.3 GB and must
      // not be pulled in by an unrelated diffusion run.
      dependency,
      estimatedDurationMs
    }
  } as WorldTestDef<TId, P>
}

export const SCENE_WIDTH = 448
export const SCENE_HEIGHT = 256

/**
 * The prompt every scene in this category is created from.
 *
 * The leading `| unknown |` is the engine's own caption prefix, not decoration
 * -- kept verbatim from the executor so the two paths create the same world.
 */
const SCENE_PROMPT = '| unknown | A realistic outdoor world scene with a navigable path.'

/**
 * Bring a world up on the session.
 *
 * `returnPack` is deliberately off: the pack is ~14 MB base64 on the wire and
 * the walk tests only need the world live. `stats` is their completion signal.
 */
const createScene = (extra: Record<string, unknown> = {}): Step[] => [
  { useModel: { deps: ['world'], as: 'model' } },
  { asset: { kind: 'image', file: '$params.image', form: 'bytes', as: 'image' } },
  {
    call: {
      method: 'worldCreateScene',
      params: {
        modelId: '$model',
        prompt: SCENE_PROMPT,
        image: '$image',
        width: SCENE_WIDTH,
        height: SCENE_HEIGHT,
        ...extra
      },
      as: 'scene'
    }
  }
]

/** One walk step, with the frames and the engine's own account of it. */
const walk = (keys: unknown, as: string): Step[] => [
  {
    call: {
      method: 'worldStep',
      collect: 'all',
      params: { modelId: '$model', keys },
      as
    }
  },
  { project: { from: `$${as}`, path: 'all', as: `${as}Frames` } }
]

/** A block of frames at the tier this category runs at. */
const blockOf = (count: number, as: string): Step => ({
  assert: {
    on: `$${as}Frames`,
    named: 'framesAre',
    with: { count, width: SCENE_WIDTH, height: SCENE_HEIGHT }
  }
})

/** PNG IHDR or JPEG SOF0 dimensions, so both frame encodings are accepted. */
function readFrameDims(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 24) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) return null
      const marker = buf[offset + 1]!
      const length = view.getUint16(offset + 2, false)
      // SOF0..SOF3 — baseline, extended, progressive and lossless. Excludes
      // 0xC4 (DHT), which shares the 0xCn range but is not a frame header.
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          width: view.getUint16(offset + 7, false),
          height: view.getUint16(offset + 5, false)
        }
      }
      offset += 2 + length
    }
  }
  return null
}

function framesAre(expectedCount: number, label: string) {
  return (frames: unknown): TestResult => {
    if (!Array.isArray(frames) || frames.length !== expectedCount) {
      return {
        passed: false,
        output: `${label}: expected ${expectedCount} frames, got ${Array.isArray(frames) ? frames.length : typeof frames}`
      }
    }
    for (const frame of frames as Uint8Array[]) {
      const dims = readFrameDims(frame)
      if (!dims || dims.width !== SCENE_WIDTH || dims.height !== SCENE_HEIGHT) {
        return {
          passed: false,
          output: `${label}: frame is ${dims ? `${dims.width}x${dims.height}` : 'undecodable'}, expected ${SCENE_WIDTH}x${SCENE_HEIGHT}`
        }
      }
    }
    return {
      passed: true,
      output: `${label}: ${expectedCount} frames at ${SCENE_WIDTH}x${SCENE_HEIGHT}`
    }
  }
}

export const worldCreateSceneReturnsPack = createWorldTest(
  'world-create-scene-returns-pack',
  { image: 'elephant.jpg', width: SCENE_WIDTH, height: SCENE_HEIGHT },
  {
    validation: 'function',
    fn: (result: unknown): TestResult => {
      const scene = result as Uint8Array | undefined
      if (!scene || scene.length < 1024) {
        return {
          passed: false,
          output: `scene pack is ${scene ? `${scene.length} bytes` : 'missing'}`
        }
      }
      // safetensors: little-endian u64 header length, then that many bytes of
      // JSON starting with '{'. Cheap structural check that the bytes are a
      // real container rather than an error page or a truncated write.
      const view = new DataView(scene.buffer, scene.byteOffset, scene.byteLength)
      const headerLen = Number(view.getBigUint64(0, true))
      if (headerLen <= 0 || headerLen + 8 > scene.length || scene[8] !== 0x7b) {
        return { passed: false, output: `not a safetensors container (header length ${headerLen})` }
      }
      return { passed: true, output: `scene pack: ${scene.length} bytes, header ${headerLen}` }
    }
  }
)

// 9 on the first block after a load (decoder warmup), 12 thereafter — pinned
// because a change here means the block/frame plumbing shifted.
export const worldFirstBlockFrames = createWorldTest(
  'world-first-block-frames',
  { image: 'elephant.jpg', keys: ['W', 'L'], expectedActionMask: 129 },
  { validation: 'function', fn: framesAre(9, 'first block') }
)

export const worldSecondBlockFrames = createWorldTest(
  'world-second-block-frames',
  { image: 'elephant.jpg', keys: [], expectedActionMask: 0 },
  { validation: 'function', fn: framesAre(12, 'idle block') }
)

export const worldStepBeforeSceneFails = createWorldTest(
  'world-step-before-scene-fails',
  {},
  { validation: 'throws-error', errorContains: 'No world exists' }
)

export const worldInvalidKeyRejected = createWorldTest(
  'world-invalid-key-rejected',
  { modelId: 'world-client-validation', keys: ['Q'] },
  { validation: 'throws-error', errorContains: 'unknown walk key' },
  { estimatedDurationMs: 60000, dependency: 'none' }
)

export const worldInvalidDimensionsRejected = createWorldTest(
  'world-invalid-dimensions-rejected',
  { modelId: 'world-client-validation', image: 'elephant.jpg', width: 833, height: 256 },
  { validation: 'throws-error', errorContains: 'multiple of 32' },
  { estimatedDurationMs: 60000, dependency: 'none' }
)

export const worldConcurrentStepRejected = createWorldTest(
  'world-concurrent-step-rejected',
  { image: 'elephant.jpg', keys: ['W'] },
  // Not 'world': the modelId itself contains "world", so a loose substring
  // would match almost any server error naming the model — including "No world
  // exists", which is a different failure entirely.
  { validation: 'throws-error', errorContains: 'rejected by registry concurrency policy' }
)

// Cancellation is block-granular — the engine cannot abort mid-block — but an
// accepted cancel must still make the step reject rather than resolve, or a
// truncated block would read as success. The executor warms the session with a
// completed step first so the cancel hits a block genuinely in flight rather
// than deferred activation, then steps again on the SAME loaded model with no
// eviction and no second worldCreateScene.
//
// 9 rather than 12 is the assertion that matters: 9 is the first block after a
// load, so it only appears if the SDK really did drop the cancelled session and
// rebuild it from the promoted pack. A session that survived the cancel would
// deliver 12 and fail here.
export const worldCancelThenReload = createWorldTest(
  'world-cancel-then-reload',
  { image: 'elephant.jpg', keys: ['W'] },
  { validation: 'function', fn: framesAre(9, 'post-cancel reload') }
)

// The bodies, attached after the definitions so each reads as one block.
worldCreateSceneReturnsPack.steps = [
  ...createScene({ returnPack: true }),
  { project: { from: '$scene', path: 'stats.sceneCreateMs', as: 'sceneCreateMs' } },
  { assert: { on: '$sceneCreateMs', named: 'atLeast', with: { value: 1 } } },
  { project: { from: '$scene', path: 'stats.width', as: 'sceneWidth' } },
  { assert: { on: '$sceneWidth', named: 'valueIn', with: { values: [SCENE_WIDTH] } } },
  { project: { from: '$scene', path: 'stats.height', as: 'sceneHeight' } },
  { assert: { on: '$sceneHeight', named: 'valueIn', with: { values: [SCENE_HEIGHT] } } },
  { project: { from: '$scene', path: 'scene', as: 'pack' } },
  { assert: { on: '$pack', named: 'safetensorsContainer', with: { minBytes: 1024 } } }
]

worldFirstBlockFrames.steps = [
  ...createScene(),
  ...walk('$params.keys', 'step'),
  blockOf(9, 'step'),
  { project: { from: '$step', path: 'stats.actionMask', as: 'actionMask' } },
  {
    assert: {
      on: '$actionMask',
      named: 'valueIn',
      with: { values: ['$params.expectedActionMask'] }
    }
  },
  { project: { from: '$step', path: 'stats.totalSteps', as: 'totalSteps' } },
  { assert: { on: '$totalSteps', named: 'valueIn', with: { values: [1] } } }
]

worldSecondBlockFrames.steps = [
  ...createScene(),
  // One step to leave the warm-up block behind, then the one under test: an
  // empty key array has to be accepted AND reach the engine as mask 0. Without
  // the mask check a silent fallback to some default key set would still
  // produce twelve frames and pass.
  ...walk(['W'], 'warmup'),
  ...walk('$params.keys', 'step'),
  blockOf(12, 'step'),
  { project: { from: '$step', path: 'stats.actionMask', as: 'actionMask' } },
  {
    assert: {
      on: '$actionMask',
      named: 'valueIn',
      with: { values: ['$params.expectedActionMask'] }
    }
  }
]

worldStepBeforeSceneFails.steps = [
  // Evict first: the resource is shared, so an earlier test may already have
  // built a world on this model and stepping would then legitimately succeed.
  // Unloading deletes the managed pack, so the reload below is a genuinely
  // world-less session -- which is the precondition this test is about.
  { call: { method: 'evictResource', params: { dep: 'world' } } },
  { useModel: { deps: ['world'], as: 'model' } },
  {
    callError: {
      method: 'worldStep',
      collect: 'all',
      params: { modelId: '$model', keys: ['W'] },
      as: 'err'
    }
  },
  { project: { from: '$err', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } }
]

worldInvalidKeyRejected.steps = [
  // No model: the key set is checked client-side before any RPC, and loading
  // the 13.3 GB ABot set to exercise a string check would be absurd.
  {
    callError: {
      method: 'worldStep',
      collect: 'all',
      params: { modelId: '$params.modelId', keys: '$params.keys' },
      as: 'err'
    }
  },
  { project: { from: '$err', path: 'message', as: 'message' } },
  // The wording is deliberately not asserted. Both clients refuse before any
  // RPC -- the SDK's own key-set check on JS, the request model's enum on
  // Python -- and each words it its own way. What crosses clients is that an
  // unknown key is refused rather than sent.
  { assert: { on: '$message', named: 'nonEmptyText' } }
]

worldInvalidDimensionsRejected.steps = [
  // Same as the invalid key: the multiple-of-32 refinement runs client-side.
  { asset: { kind: 'image', file: '$params.image', form: 'bytes', as: 'image' } },
  {
    callError: {
      method: 'worldCreateScene',
      params: {
        modelId: '$params.modelId',
        prompt: SCENE_PROMPT,
        image: '$image',
        width: '$params.width',
        height: '$params.height'
      },
      as: 'err'
    }
  },
  { project: { from: '$err', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } }
]

worldConcurrentStepRejected.steps = [
  ...createScene(),
  // The overlap is issued immediately. Waiting for a frame first would defeat
  // the test: the engine generates the whole block before emitting any frame,
  // so by the time one arrives the slot is nearly free and the second step
  // would be admitted legitimately.
  {
    start: {
      method: 'worldStep',
      collect: 'all',
      params: { modelId: '$model', keys: '$params.keys' },
      as: 'running'
    }
  },
  {
    callError: {
      method: 'worldStep',
      collect: 'all',
      params: { modelId: '$model', keys: ['S'] },
      as: 'err'
    }
  },
  { project: { from: '$err', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } },
  // Admission is proven after the fact: the first step must have run a whole
  // block. Without this the overlap could have been refused for an unrelated
  // reason and the test would report concurrency coverage it never exercised.
  { settle: { of: '$running', as: 'first' } },
  { project: { from: '$first', path: 'all', as: 'firstFrames' } },
  { assert: { on: '$firstFrames', named: 'lengthAtLeast', with: { length: 1 } } }
]

worldCancelThenReload.steps = [
  ...createScene(),
  // Warm the session with a COMPLETED step first, or the cancel races the
  // deferred activation and is refused before dispatch -- a real path, but not
  // the one this test is named for.
  ...walk('$params.keys', 'warmup'),
  { assert: { on: '$warmupFrames', named: 'lengthAtLeast', with: { length: 1 } } },
  {
    start: {
      method: 'worldStep',
      collect: 'all',
      params: { modelId: '$model', keys: '$params.keys' },
      as: 'inflight'
    }
  },
  // A broad cancel on the model rather than by request id: only one step is in
  // flight, and the id of a started call is not something a step can name.
  { call: { method: 'cancel', params: { modelId: '$model' } } },
  // An accepted cancel must make the step reject. The original accepted either
  // outcome, which made it unfalsifiable: with cancellation removed entirely
  // every run would take the "resolved" branch and still pass.
  { settle: { of: '$inflight', as: 'cancelled', expect: 'reject' } },
  { assert: { on: '$cancelled', named: 'errorIsStructured' } },
  // Nine rather than twelve is the assertion that matters: nine is the first
  // block after a load, so it only appears if the SDK really did drop the
  // cancelled session and rebuild it from the promoted pack. A session that
  // survived the cancel would deliver twelve and fail here.
  ...walk('$params.keys', 'step'),
  blockOf(9, 'step')
]

export const worldTests = [
  worldCreateSceneReturnsPack,
  worldFirstBlockFrames,
  worldSecondBlockFrames,
  worldStepBeforeSceneFails,
  worldInvalidKeyRejected,
  worldInvalidDimensionsRejected,
  worldConcurrentStepRejected,
  worldCancelThenReload
]
