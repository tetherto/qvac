// Diffusion test definitions
import type { Step, TestDefinition, TestResult } from '@qvac/test-suite'

type ExpectationLike =
  | { validation: 'type'; expectedType: 'string' | 'number' | 'array' }
  | { validation: 'throws-error'; errorContains: string }
  | { validation: 'function'; fn: (result: unknown) => TestResult }

type DiffusionTestOptions = {
  estimatedDurationMs?: number
  suites?: string[]
  dependency?: string
  /** A hand-written body, for the tests that are more than one generation. */
  steps?: Step[]
}

// Generic so `typeof someTest.testId`/`typeof someTest.params` keep their literal
// types — that's what feeds `BaseExecutor`'s typed handlers map and lets each
// handler method see real `params` instead of `any`.
export type DiffusionTestDef<
  TId extends string,
  P extends Record<string, unknown>
> = TestDefinition & { testId: TId; params: P }

/** Param names that are file names before the run and bytes during it. */
const DIFFUSION_ASSET_KEYS = new Set(['init_image', 'init_images'])

/**
 * One diffusion run, checked against its outputs.
 *
 * The call parameters ARE the test's params -- the executor passed them
 * through untouched -- so the body generates the passthrough from whatever the
 * definition declares rather than listing twenty optional fields that would
 * drift from the SDK the moment one is added.
 */
const diffusionSteps = (
  dependency: string,
  params: Record<string, unknown>,
  fold: 'all' | 'last' | 'events' = 'all'
): Step[] => {
  const steps: Step[] = [{ useModel: { deps: [dependency], as: 'model' } }]

  const call: Record<string, unknown> = { modelId: '$model' }
  for (const key of Object.keys(params)) {
    if (DIFFUSION_ASSET_KEYS.has(key)) continue
    call[key] = `$params.${key}`
  }

  // A single reference image resolves through `asset`, which is what makes the
  // same definition runnable where a file path is not a thing.
  if (typeof params.init_image === 'string') {
    steps.push({
      asset: { kind: 'image', file: '$params.init_image', form: 'bytes', as: 'initImage' }
    })
    call.init_image = '$initImage'
  }

  steps.push({ call: { method: 'diffusion', collect: fold, params: call, as: 'run' } })
  steps.push({ project: { from: '$run', path: fold, as: 'outputs' } })
  steps.push({ assert: { on: '$outputs', use: 'expectation' } })
  return steps
}

/**
 * Bodies that are more than one run: a seed compared against a second run with
 * the same seed, an img2img output weighed against its txt2img baseline, a
 * progress stream asserted on, a standalone upscaler.
 */
const DIFFUSION_MULTI_RUN = new Set([
  'diffusion-seed-reproducibility',
  'diffusion-img2img-vs-txt2img-baseline',
  'diffusion-fusion-flux2-basic',
  'diffusion-streaming-progress',
  'diffusion-stats-valid',
  'diffusion-standalone-upscaler-x4',
  'diffusion-standalone-upscaler-backend-device'
])

/**
 * The same generation twice, compared.
 *
 * `seed-reproducibility` runs it unchanged and demands identical bytes;
 * `img2img-vs-txt2img` and `fusion` drop the reference image from the second
 * and demand the opposite -- a backend that ignored the reference would give
 * two nearly identical outputs, which is exactly what the floor catches.
 */
const twoRunSteps = (
  call: Record<string, unknown>,
  second: Record<string, unknown>,
  check: Step
): Step[] => [
  { useModel: { deps: ['diffusion'], as: 'model' } },
  {
    call: { method: 'diffusion', collect: 'all', params: { modelId: '$model', ...call }, as: 'a' }
  },
  { project: { from: '$a', path: 'all[0]', as: 'first' } },
  {
    call: {
      method: 'diffusion',
      collect: 'all',
      params: { modelId: '$model', ...call, ...second },
      as: 'b'
    }
  },
  { project: { from: '$b', path: 'all[0]', as: 'second' } },
  check
]

/** The phase timings a diffusion run reports, and what they have to add up to. */
const PHASE_FIELDS = ['conditionerMs', 'denoiseMs', 'vaeMs', 'postProcessMs']

/**
 * The standalone upscaler: no prompt, no diffusion, just an image in and a
 * bigger one out.
 *
 * Its own body rather than the generic one, because the generic body calls
 * `diffusion` -- which is a different method, and would have been handed an
 * `image` parameter it does not take.
 */
const upscaleSteps = (dependency: string, checks: Step[]): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  { asset: { kind: 'image', file: '$params.image', form: 'bytes', as: 'image' } },
  {
    call: {
      method: 'upscale',
      collect: 'all',
      params: { modelId: '$model', image: '$image', repeats: '$params.repeats?' },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'all', as: 'outputs' } },
  { assert: { on: '$outputs', named: 'lengthAtLeast', with: { length: 1 } } },
  ...checks
]

function createDiffusionTest<const TId extends string, const P extends Record<string, unknown>>(
  testId: TId,
  params: P,
  expectation: ExpectationLike,
  options: DiffusionTestOptions = {}
): DiffusionTestDef<TId, P> {
  const { estimatedDurationMs = 300000, suites, dependency = 'diffusion', steps } = options
  return {
    testId,
    params,
    expectation,
    ...(suites && { suites }),
    ...(steps && { steps }),
    metadata: {
      category: 'diffusion',
      dependency,
      estimatedDurationMs
    }
  } as DiffusionTestDef<TId, P>
}

// Read PNG IHDR width/height: 8-byte signature, 4-byte chunk length, 4-byte
// "IHDR" tag, then big-endian uint32 width and uint32 height at offsets 16/20.
function readPngDims(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 24) return null
  const sig = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  if (!sig) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) }
}

// Shared PNG-dimension validator: asserts first output is a PNG of expected size.
// `label` lets callers identify themselves in the failure message.
function validatePngDims(expectedWidth: number, expectedHeight: number, label: string) {
  return (result: unknown): TestResult => {
    if (!Array.isArray(result) || result.length === 0) {
      return { passed: false, output: 'No outputs generated' }
    }
    const out = result[0]
    if (!(out instanceof Uint8Array)) {
      return { passed: false, output: 'First output is not a Uint8Array' }
    }
    const dims = readPngDims(out)
    if (!dims) {
      return { passed: false, output: 'Output is not a valid PNG' }
    }
    const passed = dims.width === expectedWidth && dims.height === expectedHeight
    return {
      passed,
      output: passed
        ? `${label} OK: ${dims.width}x${dims.height}`
        : `${label}: expected ${expectedWidth}x${expectedHeight}, got ${dims.width}x${dims.height}`
    }
  }
}

// ---- txt2img ----

export const diffusionBasicTxt2img = createDiffusionTest(
  'diffusion-basic-txt2img',
  {
    prompt: 'a solid red square on white background',
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' },
  { suites: ['smoke'] }
)

export const diffusionDefaultSize = createDiffusionTest(
  'diffusion-default-size',
  {
    prompt: 'a blue circle',
    width: 256,
    height: 256,
    steps: 2,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' }
)

export const diffusionNegativePrompt = createDiffusionTest(
  'diffusion-negative-prompt',
  {
    prompt: 'a landscape painting',
    negative_prompt: 'blurry, low quality',
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' }
)

export const diffusionCfgScale = createDiffusionTest(
  'diffusion-cfg-scale',
  {
    prompt: 'a mountain landscape',
    width: 256,
    height: 256,
    steps: 4,
    cfg_scale: 12.0,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' }
)

export const diffusionSamplerEulerA = createDiffusionTest(
  'diffusion-sampler-euler-a',
  {
    prompt: 'a green forest',
    width: 256,
    height: 256,
    steps: 4,
    sampling_method: 'euler_a',
    seed: 42
  },
  { validation: 'type', expectedType: 'array' }
)

export const diffusionSamplerHeun = createDiffusionTest(
  'diffusion-sampler-heun',
  {
    prompt: 'a sunset over ocean',
    width: 256,
    height: 256,
    steps: 4,
    sampling_method: 'heun',
    seed: 42
  },
  { validation: 'type', expectedType: 'array' }
)

export const diffusionSchedulerKarras = createDiffusionTest(
  'diffusion-scheduler-karras',
  {
    prompt: 'abstract art',
    width: 256,
    height: 256,
    steps: 4,
    scheduler: 'karras',
    seed: 42
  },
  { validation: 'type', expectedType: 'array' }
)

export const diffusionSeedReproducibility = createDiffusionTest(
  'diffusion-seed-reproducibility',
  {
    prompt: 'a red triangle',
    width: 256,
    height: 256,
    steps: 4,
    seed: 12345
  },
  { validation: 'type', expectedType: 'string' },
  {
    estimatedDurationMs: 600000,
    steps: twoRunSteps(
      {
        prompt: '$params.prompt',
        width: '$params.width',
        height: '$params.height',
        steps: '$params.steps',
        seed: '$params.seed'
      },
      {},
      {
        compare: { left: '$first', right: '$second', named: 'identicalBytes' }
      }
    )
  }
)

export const diffusionBatchCount = createDiffusionTest(
  'diffusion-batch-count',
  {
    prompt: 'a simple shape',
    width: 256,
    height: 256,
    steps: 4,
    batch_count: 2,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' },
  { estimatedDurationMs: 600000 }
)

// ---- img2img ----
// Source asset is 256x256 to match request width/height: FLUX.2 auto-resize is
// a no-op and SD 2.1 SDEdit emits source-sized output, so output is 256x256 on
// both engines.

export const diffusionBasicImg2img = createDiffusionTest(
  'diffusion-basic-img2img',
  {
    prompt: 'oil painting style, vibrant colors',
    init_image: 'elephant.jpg',
    strength: 0.5,
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' }
)

// FLUX.2 ignores img_cfg_scale (in-context conditioning); SD 2.1 honors it via
// SDEdit. Schema accept + PNG size check is the strongest cross-platform
// assertion without per-engine branching.
export const diffusionImg2imgImgCfgScale = createDiffusionTest(
  'diffusion-img2img-img-cfg-scale',
  {
    prompt: 'oil painting style',
    init_image: 'diffusion-img2img-source-256.png',
    strength: 0.5,
    img_cfg_scale: 5.0,
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'function', fn: validatePngDims(256, 256, 'img2img PNG') },
  {
    steps: [
      { useModel: { deps: ['diffusion'], as: 'model' } },
      { asset: { kind: 'image', file: '$params.init_image', form: 'bytes', as: 'initImage' } },
      {
        call: {
          method: 'diffusion',
          collect: 'all',
          params: {
            modelId: '$model',
            prompt: '$params.prompt',
            init_image: '$initImage',
            strength: '$params.strength',
            img_cfg_scale: '$params.img_cfg_scale',
            width: '$params.width',
            height: '$params.height',
            steps: '$params.steps',
            seed: '$params.seed'
          },
          as: 'run'
        }
      },
      { project: { from: '$run', path: 'all', as: 'outputs' } },
      {
        assert: {
          on: '$outputs',
          named: 'pngDimensions',
          with: { width: '$params.width', height: '$params.height' }
        }
      }
    ]
  }
)

export const diffusionImg2imgVsTxt2imgBaseline = createDiffusionTest(
  'diffusion-img2img-vs-txt2img-baseline',
  {
    prompt: 'watercolor style',
    init_image: 'diffusion-img2img-source-256.png',
    strength: 0.5,
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' },
  {
    estimatedDurationMs: 600000,
    // The second run drops `init_image`. If the backend ignored the reference
    // the two outputs would collapse onto each other, which the floor catches.
    steps: [
      { asset: { kind: 'image', file: '$params.init_image', form: 'bytes', as: 'initImage' } },
      ...twoRunSteps(
        {
          prompt: '$params.prompt',
          init_image: '$initImage',
          strength: '$params.strength',
          width: '$params.width',
          height: '$params.height',
          steps: '$params.steps',
          seed: '$params.seed'
        },
        // `null` rather than an omitted key: the second call has to be the
        // same call with the reference taken out, and an optional reference
        // that resolves to nothing is dropped from the params entirely.
        { init_image: '$missing?' },
        {
          compare: {
            left: '$first',
            right: '$second',
            named: 'imageDivergesFrom',
            with: { minRatio: 0.01 }
          }
        }
      )
    ]
  }
)

export const diffusionImg2imgInvalidStrength = createDiffusionTest(
  'diffusion-img2img-invalid-strength',
  {
    prompt: 'test',
    init_image: 'diffusion-img2img-source-256.png',
    strength: 1.5,
    width: 256,
    height: 256,
    steps: 4
  },
  {
    validation: 'throws-error',
    // Match the field path rather than the Zod message — stable across version
    // bumps that rephrase numeric-bound messages.
    errorContains: 'strength'
  },
  {
    estimatedDurationMs: 60000,
    steps: [
      { useModel: { deps: ['diffusion'], as: 'model' } },
      { asset: { kind: 'image', file: '$params.init_image', form: 'bytes', as: 'initImage' } },
      {
        callError: {
          method: 'diffusion',
          collect: 'all',
          params: {
            modelId: '$model',
            prompt: '$params.prompt',
            init_image: '$initImage',
            strength: '$params.strength',
            width: '$params.width',
            height: '$params.height',
            steps: '$params.steps'
          },
          as: 'err'
        }
      },
      { project: { from: '$err', path: 'message', as: 'message' } },
      { assert: { on: '$message', use: 'expectation' } }
    ]
  }
)

// ---- streaming ----

export const diffusionStreaming = createDiffusionTest(
  'diffusion-streaming',
  {
    prompt: 'a yellow star',
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' },
  {
    steps: [
      { useModel: { deps: ['diffusion'], as: 'model' } },
      {
        call: {
          method: 'diffusion',
          collect: 'all',
          params: {
            modelId: '$model',
            prompt: '$params.prompt',
            width: '$params.width',
            height: '$params.height',
            steps: '$params.steps',
            seed: '$params.seed'
          },
          as: 'run'
        }
      },
      { project: { from: '$run', path: 'all', as: 'outputs' } },
      { assert: { on: '$outputs', use: 'expectation' } }
    ]
  }
)

export const diffusionStreamingProgress = createDiffusionTest(
  'diffusion-streaming-progress',
  {
    prompt: 'a purple diamond',
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'type', expectedType: 'string' },
  {
    estimatedDurationMs: 300000,
    suites: ['smoke'],
    // One run answers all three: images came back, progress ticked, and every
    // tick carried the step counters a caller would draw a progress bar from.
    steps: [
      { useModel: { deps: ['diffusion'], as: 'model' } },
      {
        call: {
          method: 'diffusion',
          collect: 'events',
          params: {
            modelId: '$model',
            prompt: '$params.prompt',
            width: '$params.width',
            height: '$params.height',
            steps: '$params.steps',
            seed: '$params.seed'
          },
          as: 'run'
        }
      },
      { project: { from: '$run', path: 'all', as: 'outputs' } },
      { assert: { on: '$outputs', named: 'lengthAtLeast', with: { length: 1 } } },
      { project: { from: '$run', path: 'events', as: 'ticks' } },
      { assert: { on: '$ticks', named: 'lengthAtLeast', with: { length: 1 } } },
      {
        repeat: {
          over: '$ticks',
          as: 'tick',
          collectInto: 'checkedTicks',
          steps: [
            {
              assert: {
                on: '$tick',
                named: 'nonNegativeNumbers',
                with: { fields: ['step', 'totalSteps', 'elapsedMs'] }
              }
            }
          ]
        }
      },
      { project: { from: '$run', path: 'stats', as: 'stats' } },
      { assert: { on: '$stats', named: 'fieldsPresent', with: { fields: ['generationMs'] } } }
    ]
  }
)

// ---- stats ----

export const diffusionStatsValid = createDiffusionTest(
  'diffusion-stats-valid',
  {
    prompt: 'a white circle on black background',
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'type', expectedType: 'string' },
  {
    // The phase timings have to reconcile with the total: if they do not, some
    // phase is not being accounted for, and the breakdown a caller profiles
    // against is wrong without any single number looking wrong.
    steps: [
      { useModel: { deps: ['diffusion'], as: 'model' } },
      {
        call: {
          method: 'diffusion',
          collect: 'all',
          params: {
            modelId: '$model',
            prompt: '$params.prompt',
            width: '$params.width',
            height: '$params.height',
            steps: '$params.steps',
            seed: '$params.seed'
          },
          as: 'run'
        }
      },
      { project: { from: '$run', path: 'stats', as: 'stats' } },
      { assert: { on: '$stats', named: 'nonNegativeNumbers', with: { fields: PHASE_FIELDS } } },
      {
        assert: {
          on: '$stats',
          named: 'positiveIntegers',
          with: { fields: ['totalSteps'] }
        }
      },
      {
        assert: {
          on: '$stats',
          named: 'timingStatsPresent',
          with: { field: 'stepsPerSecond' }
        }
      },
      {
        assert: {
          on: '$stats',
          named: 'fieldsSumTo',
          with: { fields: PHASE_FIELDS, total: 'generationMs', ratio: 0.01, minTolerance: 2 }
        }
      }
    ]
  }
)

// ---- diffusion_fa config flag ----

export const diffusionFaAccepted = createDiffusionTest(
  'diffusion-fa-loads-and-runs',
  {
    prompt: 'a solid blue circle on white background',
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' },
  { dependency: 'diffusion-fa' }
)

export const diffusionFaDisabledAccepted = createDiffusionTest(
  'diffusion-fa-disabled-loads-and-runs',
  {
    prompt: 'a solid blue circle on white background',
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' },
  { dependency: 'diffusion-fa-disabled' }
)

// ---- FLUX.2 multi-reference fusion ----

export const diffusionFusionFlux2Basic = createDiffusionTest(
  'diffusion-fusion-flux2-basic',
  {
    prompt: 'a portrait using most visual traits from @image1 and the eyes from @image2',
    init_images: ['cat.jpg', 'elephant.jpg'],
    width: 256,
    height: 256,
    steps: 4,
    seed: 42
  },
  { validation: 'type', expectedType: 'array' },
  {
    estimatedDurationMs: 600000,
    // Same shape as the img2img baseline: the second run drops the reference
    // images, and if the addon ignored them the outputs would collapse
    // together.
    steps: [
      { asset: { kind: 'image', file: 'cat.jpg', form: 'bytes', as: 'firstImage' } },
      { asset: { kind: 'image', file: 'elephant.jpg', form: 'bytes', as: 'secondImage' } },
      ...twoRunSteps(
        {
          prompt: '$params.prompt',
          init_images: ['$firstImage', '$secondImage'],
          width: '$params.width',
          height: '$params.height',
          steps: '$params.steps',
          seed: '$params.seed'
        },
        { init_images: '$missing?' },
        {
          compare: {
            left: '$first',
            right: '$second',
            named: 'imageDivergesFrom',
            with: { minRatio: 0.01 }
          }
        }
      )
    ]
  }
)

// ---- ESRGAN upscale ----

const ESRGAN_SCALE = 4
const ESRGAN_SOURCE_WIDTH = 128
const ESRGAN_SOURCE_HEIGHT = 128
const STANDALONE_UPSCALER_SOURCE_WIDTH = 64
const STANDALONE_UPSCALER_SOURCE_HEIGHT = 64

export const diffusionEsrganUpscaleX4 = createDiffusionTest(
  'diffusion-esrgan-upscale-x4',
  {
    prompt: 'a solid red square on white background',
    width: ESRGAN_SOURCE_WIDTH,
    height: ESRGAN_SOURCE_HEIGHT,
    steps: 4,
    seed: 42,
    upscale: true
  },
  {
    validation: 'function',
    fn: validatePngDims(
      ESRGAN_SOURCE_WIDTH * ESRGAN_SCALE,
      ESRGAN_SOURCE_HEIGHT * ESRGAN_SCALE,
      `ESRGAN x${ESRGAN_SCALE}`
    )
  },
  {
    estimatedDurationMs: 600000,
    dependency: 'diffusion-esrgan',
    steps: [
      { useModel: { deps: ['diffusion-esrgan'], as: 'model' } },
      {
        call: {
          method: 'diffusion',
          collect: 'all',
          params: {
            modelId: '$model',
            prompt: '$params.prompt',
            width: '$params.width',
            height: '$params.height',
            steps: '$params.steps',
            seed: '$params.seed',
            upscale: '$params.upscale'
          },
          as: 'run'
        }
      },
      { project: { from: '$run', path: 'all', as: 'outputs' } },
      {
        assert: {
          on: '$outputs',
          named: 'pngDimensions',
          with: {
            width: ESRGAN_SOURCE_WIDTH * ESRGAN_SCALE,
            height: ESRGAN_SOURCE_HEIGHT * ESRGAN_SCALE
          }
        }
      }
    ]
  }
)

export const diffusionStandaloneUpscalerX4 = createDiffusionTest(
  'diffusion-standalone-upscaler-x4',
  {
    image: 'small-64.jpg',
    repeats: 1
  },
  {
    validation: 'function',
    fn: validatePngDims(
      STANDALONE_UPSCALER_SOURCE_WIDTH * ESRGAN_SCALE,
      STANDALONE_UPSCALER_SOURCE_HEIGHT * ESRGAN_SCALE,
      `Standalone upscaler x${ESRGAN_SCALE}`
    )
  },
  {
    estimatedDurationMs: 600000,
    dependency: 'upscaler',
    steps: upscaleSteps('upscaler', [
      {
        assert: {
          on: '$outputs',
          named: 'pngDimensions',
          with: {
            width: STANDALONE_UPSCALER_SOURCE_WIDTH * ESRGAN_SCALE,
            height: STANDALONE_UPSCALER_SOURCE_HEIGHT * ESRGAN_SCALE
          }
        }
      }
    ])
  }
)

export const diffusionStandaloneUpscalerBackendDevice = createDiffusionTest(
  'diffusion-standalone-upscaler-backend-device',
  {
    image: 'small-64.jpg',
    repeats: 1
  },
  { validation: 'type', expectedType: 'string' },
  {
    estimatedDurationMs: 1000,
    dependency: 'upscaler',
    // Which device the work landed on is the claim; either answer is
    // acceptable, an absent or unknown one is not.
    steps: upscaleSteps('upscaler', [
      { project: { from: '$run', path: 'stats.backendDevice', as: 'device' } },
      { assert: { on: '$device', named: 'valueIn', with: { values: ['cpu', 'gpu'] } } }
    ])
  }
)

export const diffusionStandaloneUpscalerCpu = createDiffusionTest(
  'diffusion-standalone-upscaler-cpu',
  {
    image: 'small-64.jpg',
    repeats: 1
  },
  { validation: 'type', expectedType: 'string' },
  {
    estimatedDurationMs: 2000,
    dependency: 'upscaler-cpu',
    suites: ['smoke'],
    steps: upscaleSteps('upscaler-cpu', [
      { project: { from: '$run', path: 'stats.backendDevice', as: 'device' } },
      { assert: { on: '$device', named: 'valueIn', with: { values: ['cpu'] } } }
    ])
  }
)

export const diffusionTests = [
  diffusionBasicTxt2img,
  diffusionDefaultSize,
  diffusionNegativePrompt,
  diffusionCfgScale,
  diffusionSamplerEulerA,
  diffusionSamplerHeun,
  diffusionSchedulerKarras,
  diffusionSeedReproducibility,
  diffusionBatchCount,
  diffusionBasicImg2img,
  diffusionImg2imgImgCfgScale,
  diffusionImg2imgVsTxt2imgBaseline,
  diffusionImg2imgInvalidStrength,
  diffusionStreaming,
  diffusionStreamingProgress,
  diffusionStatsValid,
  diffusionFaAccepted,
  diffusionFaDisabledAccepted,
  diffusionFusionFlux2Basic,
  diffusionEsrganUpscaleX4,
  diffusionStandaloneUpscalerX4,
  diffusionStandaloneUpscalerBackendDevice,
  diffusionStandaloneUpscalerCpu
] as const

/**
 * Attach a body to every definition that is one run. Tests that take several
 * images, or that expect a rejection, keep their hand-written bodies for now:
 * the first needs a repeat over assets, the second is about the load path.
 */
for (const test of diffusionTests) {
  if (test.steps || DIFFUSION_MULTI_RUN.has(test.testId)) continue
  if (test.expectation.validation !== 'type') continue
  const params = test.params as Record<string, unknown>
  if (Array.isArray(params.init_images)) continue
  test.steps = diffusionSteps(String(test.metadata?.dependency ?? 'diffusion'), params)
}
