import type { Expectation, Step, TestDefinition } from '@qvac/test-suite'

/**
 * One image-attached completion.
 *
 * The `asset` step with `form: 'path'` is what collapses this category's two
 * executors into one. They differed in exactly one thing -- `path.resolve` on
 * desktop against a bundled-asset URI on mobile -- and resolving that is the
 * platform's job, not the test's.
 */
const visionSteps = (dependency: string): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  { asset: { kind: 'image', file: '$params.image', form: 'path', as: 'image' } },
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: [
          {
            role: 'user',
            content: '$params.prompt',
            attachments: [{ path: '$image' }]
          }
        ],
        stream: '$params.stream?',
        generationParams: '$params.generationParams?'
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  { assert: { on: '$text', use: 'expectation' } }
]

const createVisionTest = (
  testId: string,
  prompt: string,
  imagePath: string,
  expectation: Expectation,
  opts: {
    stream?: boolean
    estimatedDurationMs?: number
    generationParams?: Record<string, unknown>
  } = {},
  suites?: string[]
): TestDefinition => ({
  testId,
  params: {
    // The prompt and the image, named separately, are what the declarative
    // body builds its history from; `history` below stays for the executors
    // the other platforms still run.
    prompt,
    image: imagePath,
    history: [
      {
        role: 'user',
        content: prompt,
        attachments: [{ path: `shared-test-data/images/${imagePath}` }]
      }
    ],
    ...(opts.stream && { stream: true }),
    ...(opts.generationParams && { generationParams: opts.generationParams })
  },
  expectation,
  ...(suites && { suites }),
  steps: visionSteps('vision'),
  metadata: {
    category: 'vision',
    dependency: 'vision',
    estimatedDurationMs: opts.estimatedDurationMs ?? 20000
  }
})

/**
 * A completion whose history the test writes out, with the images the `asset`
 * steps resolved substituted in.
 *
 * A `$ref` inside `params` is data, not a reference: the interpreter resolves
 * the step's own parameters and does not walk back into the value it just
 * read. So a history carrying resolved attachments is built here, as a
 * function of them, and `params` calls the same function with the catalog
 * names.
 */
const visionHistorySteps = (history: unknown, assets: Step[], checks: Step[]): Step[] => [
  { useModel: { deps: ['vision'], as: 'model' } },
  ...assets,
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history,
        generationParams: '$params.generationParams?'
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'text', as: 'text' } },
  ...checks
]

/** The same call, expected to be refused because the image cannot be read. */
const visionRejects = (history: unknown, assets: Step[] = []): Step[] => [
  { useModel: { deps: ['vision'], as: 'model' } },
  ...assets,
  {
    callError: {
      method: 'completion',
      collect: 'text',
      params: { modelId: '$model', history },
      as: 'err'
    }
  },
  { project: { from: '$err', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } }
]

const ELEPHANT_IMAGE_TERMS = ['elephant', 'tusk', 'trunk']

export const visionBasic = createVisionTest(
  'vision-basic',
  'What animal is in this image?',
  'elephant.jpg',
  { validation: 'contains-any', contains: ELEPHANT_IMAGE_TERMS },
  { generationParams: { temp: 0, seed: 42 } },
  ['smoke']
)

export const visionStreaming = createVisionTest(
  'vision-streaming',
  'What do you see in this image?',
  'elephant.jpg',
  { validation: 'contains-any', contains: ELEPHANT_IMAGE_TERMS },
  { stream: true, generationParams: { temp: 0, seed: 42 } },
  ['smoke']
)

export const visionStats = createVisionTest(
  'vision-stats',
  'Describe this image briefly.',
  'elephant.jpg',
  { validation: 'contains-any', contains: ELEPHANT_IMAGE_TERMS },
  { generationParams: { temp: 0, seed: 42 } }
)

const noUpscaleHistory = (image: string) => [
  {
    role: 'user',
    content: 'Describe this image briefly.',
    attachments: [{ path: image }]
  }
]

/**
 * A 64x64 image must not be upscaled on its way in.
 *
 * The expectation was `fn: () => true`, so the executor's only real claim was
 * that the call came back at all. Kept as that plus "it said something",
 * which is what the body can honestly check -- whether the pixels were
 * resized is not visible from the client.
 */
export const visionImageNoUpscale: TestDefinition = {
  testId: 'vision-image-no-upscale',
  params: {
    image: 'small-64.jpg',
    history: noUpscaleHistory('shared-test-data/images/small-64.jpg'),
    generationParams: { temp: 0, top_k: 1, seed: 42, predict: 8 }
  },
  expectation: { validation: 'function', fn: () => true },
  steps: visionHistorySteps(
    noUpscaleHistory('$image'),
    [{ asset: { kind: 'image', file: '$params.image', form: 'path', as: 'image' } }],
    [{ assert: { on: '$text', named: 'nonEmptyText' } }]
  ),
  metadata: {
    category: 'vision',
    dependency: 'vision',
    estimatedDurationMs: 120000
  }
}

export const visionFormatPng = createVisionTest(
  'vision-format-png',
  'Describe this image.',
  'logo.png',
  { validation: 'type', expectedType: 'string' }
)

export const visionFormatWebp = createVisionTest(
  'vision-format-webp',
  'Describe this image.',
  'photo-webp.webp',
  { validation: 'type', expectedType: 'string' },
  { estimatedDurationMs: 110000 }
)

export const visionLargeImage = createVisionTest(
  'vision-large-image',
  'Describe this image.',
  'large-4k.jpg',
  { validation: 'type', expectedType: 'string' },
  { estimatedDurationMs: 90000 }
)

export const visionSmallImage = createVisionTest(
  'vision-small-image',
  'Describe this image.',
  'small-64.jpg',
  { validation: 'type', expectedType: 'string' }
)

export const visionObjectDetection = createVisionTest(
  'vision-object-detection',
  'List all the objects you can identify in this image.',
  'room.jpg',
  { validation: 'contains-any', contains: ['sofa', 'couch', 'table', 'lamp', 'window'] },
  { generationParams: { temp: 0, seed: 42 } }
)

export const visionTextExtraction = createVisionTest(
  'vision-text-extraction',
  'Read the text in this image. Reply with only the text.',
  'sign.jpg',
  { validation: 'contains-all', contains: ['hello'] },
  { generationParams: { temp: 0, top_k: 1, seed: 42, predict: 128 } }
)

export const visionSceneUnderstanding = createVisionTest(
  'vision-scene-understanding',
  'Describe the scene in this image.',
  'scene.jpg',
  { validation: 'type', expectedType: 'string' }
)

const multipleImagesHistory = (first: string, second: string) => [
  {
    role: 'user',
    content: 'Compare these two images. What is in each one?',
    attachments: [{ path: first }, { path: second }]
  }
]

export const visionMultipleImages: TestDefinition = {
  testId: 'vision-multiple-images',
  params: {
    images: ['elephant.jpg', 'room.jpg'],
    history: multipleImagesHistory(
      'shared-test-data/images/elephant.jpg',
      'shared-test-data/images/room.jpg'
    )
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: visionHistorySteps(
    multipleImagesHistory('$first', '$second'),
    [
      { asset: { kind: 'image', file: 'elephant.jpg', form: 'path', as: 'first' } },
      { asset: { kind: 'image', file: 'room.jpg', form: 'path', as: 'second' } }
    ],
    [
      { assert: { on: '$text', use: 'expectation' } },
      { assert: { on: '$text', named: 'nonEmptyText' } }
    ]
  ),
  metadata: {
    category: 'vision',
    dependency: 'vision',
    estimatedDurationMs: 30000
  }
}

const multiTurnHistory = (image: string) => [
  {
    role: 'user',
    content: 'What animal is in this image?',
    attachments: [{ path: image }]
  },
  { role: 'assistant', content: 'The image shows an elephant.' },
  { role: 'user', content: 'What color is it?' }
]

export const visionMultiTurn: TestDefinition = {
  testId: 'vision-multi-turn',
  params: {
    image: 'elephant.jpg',
    history: multiTurnHistory('shared-test-data/images/elephant.jpg')
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: visionHistorySteps(
    multiTurnHistory('$image'),
    [{ asset: { kind: 'image', file: '$params.image', form: 'path', as: 'image' } }],
    [
      { assert: { on: '$text', use: 'expectation' } },
      { assert: { on: '$text', named: 'nonEmptyText' } }
    ]
  ),
  metadata: {
    category: 'vision',
    dependency: 'vision',
    estimatedDurationMs: 25000
  }
}

export const visionErrorMissingImage: TestDefinition = {
  testId: 'vision-error-missing-image',
  params: {
    history: [
      {
        role: 'user',
        content: 'What is in this image?',
        attachments: [{ path: 'shared-test-data/images/nonexistent.jpg' }]
      }
    ]
  },
  expectation: { validation: 'throws-error', errorContains: 'not found' },
  suites: ['smoke'],
  // No `asset` step: the point is a path that cannot be read, and resolving it
  // through the asset root would fail in the step rather than in the call.
  steps: visionRejects('$params.history'),
  metadata: {
    category: 'vision',
    dependency: 'vision',
    estimatedDurationMs: 10000
  }
}

const unsupportedFormatHistory = (image: string) => [
  {
    role: 'user',
    content: 'What is in this image?',
    attachments: [{ path: image }]
  }
]

export const visionErrorUnsupportedFormat: TestDefinition = {
  testId: 'vision-error-unsupported-format',
  params: {
    history: unsupportedFormatHistory('shared-test-data/images/invalid-format.bmp')
  },
  expectation: { validation: 'throws-error', errorContains: 'failed to load' },
  // This one does resolve: the file exists, it is the format the decoder
  // refuses.
  steps: visionRejects(unsupportedFormatHistory('$image'), [
    { asset: { kind: 'image', file: 'invalid-format.bmp', form: 'path', as: 'image' } }
  ]),
  metadata: {
    category: 'vision',
    dependency: 'vision',
    estimatedDurationMs: 10000
  }
}

export const visionTests = [
  visionBasic,
  visionStreaming,
  visionStats,
  visionImageNoUpscale,
  visionFormatPng,
  visionFormatWebp,
  visionLargeImage,
  visionSmallImage,
  visionObjectDetection,
  visionTextExtraction,
  visionSceneUnderstanding,
  visionMultipleImages,
  visionMultiTurn,
  visionErrorMissingImage,
  visionErrorUnsupportedFormat
]
