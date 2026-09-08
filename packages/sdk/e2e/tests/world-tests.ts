// ABot-World interactive world session test definitions.
//
// Runs at the 448x256 low-VRAM tier rather than the validated 832x480 one: the
// walk session needs ~20 GB free VRAM at 832x480, where 448x256 fits the ~6 GB
// class of card, so these can run on the shared GPU desktop runners. That makes
// this a correctness lane, not a performance one — block times here are far
// below interactive.
import type { TestDefinition, TestResult } from '@qvac/test-suite'

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
