import type { TestDefinition, Expectation } from '@qvac/test-suite'

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
  metadata: {
    category: 'vision',
    dependency: 'vision',
    estimatedDurationMs: opts.estimatedDurationMs ?? 20000
  }
})

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

export const visionImageNoUpscale: TestDefinition = {
  testId: 'vision-image-no-upscale',
  params: {
    history: [
      {
        role: 'user',
        content: 'Describe this image briefly.',
        attachments: [{ path: 'shared-test-data/images/small-64.jpg' }]
      }
    ],
    generationParams: { temp: 0, top_k: 1, seed: 42, predict: 8 }
  },
  expectation: { validation: 'function', fn: () => true },
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

export const visionMultipleImages: TestDefinition = {
  testId: 'vision-multiple-images',
  params: {
    history: [
      {
        role: 'user',
        content: 'Compare these two images. What is in each one?',
        attachments: [
          { path: 'shared-test-data/images/elephant.jpg' },
          { path: 'shared-test-data/images/room.jpg' }
        ]
      }
    ]
  },
  expectation: { validation: 'type', expectedType: 'string' },
  metadata: {
    category: 'vision',
    dependency: 'vision',
    estimatedDurationMs: 30000
  }
}

export const visionMultiTurn: TestDefinition = {
  testId: 'vision-multi-turn',
  params: {
    history: [
      {
        role: 'user',
        content: 'What animal is in this image?',
        attachments: [{ path: 'shared-test-data/images/elephant.jpg' }]
      },
      {
        role: 'assistant',
        content: 'The image shows an elephant.'
      },
      {
        role: 'user',
        content: 'What color is it?'
      }
    ]
  },
  expectation: { validation: 'type', expectedType: 'string' },
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
  metadata: {
    category: 'vision',
    dependency: 'vision',
    estimatedDurationMs: 10000
  }
}

export const visionErrorUnsupportedFormat: TestDefinition = {
  testId: 'vision-error-unsupported-format',
  params: {
    history: [
      {
        role: 'user',
        content: 'What is in this image?',
        attachments: [{ path: 'shared-test-data/images/invalid-format.bmp' }]
      }
    ]
  },
  expectation: { validation: 'throws-error', errorContains: 'failed to load' },
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
