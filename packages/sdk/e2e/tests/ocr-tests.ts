import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * One OCR run, checked the way the test asks for.
 *
 * `asset` with `form: 'path'` is what collapses this category's two executors
 * into one: `node/` and `mobile/` differed in nothing but how they turned a
 * file name into something the SDK could open.
 *
 * `collect: 'text'` folds the blocks into the joined string the expectations
 * are written against; `collect: 'blocks'` keeps them structured for the tests
 * that assert on shape rather than content.
 */
const ocrSteps = (
  dependency: string,
  wants: { wantsBlocks: boolean; checksStats: boolean; checksStructure: boolean }
): Step[] => {
  const fold = wants.wantsBlocks || wants.checksStructure ? 'blocks' : 'text'
  const steps: Step[] = [
    { useModel: { deps: [dependency], as: 'model' } },
    { asset: { kind: 'image', file: '$params.imageFileName', form: 'path', as: 'image' } },
    {
      call: {
        method: 'ocr',
        collect: fold,
        params: {
          modelId: '$model',
          image: '$image',
          stream: '$params.streaming?',
          options: '$params.ocrOptions?'
        },
        as: 'run'
      }
    },
    { project: { from: '$run', path: fold, as: fold === 'blocks' ? 'blocks' : 'text' } }
  ]

  if (wants.checksStructure) {
    steps.push({ assert: { on: '$blocks', named: 'textBlockShape' } })
  }
  steps.push({
    assert: { on: fold === 'blocks' ? '$blocks' : '$text', use: 'expectation' }
  })
  if (wants.checksStats) {
    steps.push({ project: { from: '$run', path: 'stats', as: 'stats' } })
    steps.push({
      assert: { on: '$stats', named: 'timingStatsPresent', with: { field: 'totalTime' } }
    })
  }
  return steps
}

const createOcrTest = (
  testId: string,
  imageFileName: string,
  expectation:
    | { validation: 'contains-all' | 'contains-any'; contains: string[] }
    | { validation: 'type'; expectedType: 'array' },
  options?: { streaming?: boolean; paragraph?: boolean; resource?: string },
  estimatedDurationMs: number = 30000,
  suites?: string[]
): TestDefinition => {
  const dependency = options?.resource ?? 'ocr'
  const wantsBlocks = expectation.validation === 'type'
  const checksStats = testId.endsWith('-stats')
  const checksStructure = testId.includes('block-structure')

  return {
    testId,
    params: {
      imageFileName,
      timeout: 300000,
      ...options,
      // The executor turned `paragraph` into the SDK's options object; as data
      // the object is the param, so the step passes it straight through and
      // omits it entirely when the test does not ask for it.
      ...(options?.paragraph ? { ocrOptions: { paragraph: true } } : {})
    },
    expectation,
    ...(suites && { suites }),
    steps: ocrSteps(dependency, { wantsBlocks, checksStats, checksStructure }),
    metadata: { category: 'ocr', dependency, estimatedDurationMs }
  }
}

export const ocrBasicPng = createOcrTest(
  'ocr-basic-png',
  'ocr-simple-test-png.png',
  {
    validation: 'contains-any',
    contains: ['OCR', 'text', 'testing', 'implementation', 'recognize', 'Type', 'enter']
  },
  undefined,
  60000,
  ['smoke']
)

export const ocrBasicJpg = createOcrTest(
  'ocr-basic-jpg',
  'ocr-simple-test-jpg.jpg',
  {
    validation: 'contains-any',
    contains: ['OCR', 'text', 'testing', 'implementation', 'recognize', 'Type', 'enter']
  },
  undefined,
  60000
)

export const ocrStreaming = createOcrTest(
  'ocr-streaming',
  'ocr-simple-test-png.png',
  { validation: 'contains-any', contains: ['OCR', 'text', 'testing', 'Type', 'enter'] },
  { streaming: true },
  60000,
  ['smoke']
)

export const ocrParagraphMode = createOcrTest(
  'ocr-paragraph-mode',
  'ocr-simple-test-png.png',
  { validation: 'contains-any', contains: ['OCR', 'text', 'testing', 'Type', 'enter'] },
  { paragraph: true },
  60000
)

export const ocrSignImage = createOcrTest('ocr-sign-image', 'sign.jpg', {
  validation: 'type',
  expectedType: 'array'
})

export const ocrLogoImage = createOcrTest('ocr-logo-image', 'logo.png', {
  validation: 'type',
  expectedType: 'array'
})

export const ocrChartImage = createOcrTest('ocr-chart-image', 'chart.jpg', {
  validation: 'type',
  expectedType: 'array'
})

export const ocrNoTextImage = createOcrTest('ocr-no-text-image', 'elephant.jpg', {
  validation: 'type',
  expectedType: 'array'
})

export const ocrLargeImage = createOcrTest(
  'ocr-large-image',
  'large-4k.jpg',
  { validation: 'type', expectedType: 'array' },
  undefined,
  120000
)

export const ocrSmallImage = createOcrTest('ocr-small-image', 'small-64.jpg', {
  validation: 'type',
  expectedType: 'array'
})

export const ocrLowQuality = createOcrTest('ocr-low-quality', 'low-quality.jpg', {
  validation: 'type',
  expectedType: 'array'
})

export const ocrMixedLanguage = createOcrTest('ocr-mixed-language', 'mixed-language-store.jpg', {
  validation: 'type',
  expectedType: 'array'
})

export const ocrSingleLanguage = createOcrTest('ocr-single-language', 'ocr-single-language.png', {
  validation: 'contains-all',
  contains: ['SINGLE', 'LANGUAGE', 'TEST']
})

export const ocrBlurryText = createOcrTest('ocr-blurry-text', 'ocr-blurry-text.png', {
  validation: 'contains-all',
  contains: ['SHARP', 'CLEAR']
})

export const ocrHorizontallyInverted = createOcrTest(
  'ocr-horizontally-inverted',
  'ocr-horizontally-inverted.png',
  { validation: 'type', expectedType: 'array' }
)

export const ocrVerticallyInverted = createOcrTest(
  'ocr-vertically-inverted',
  'ocr-vertically-inverted.png',
  { validation: 'type', expectedType: 'array' }
)

export const ocrMisalignedText = createOcrTest('ocr-misaligned-text', 'ocr-misaligned-text.png', {
  validation: 'contains-any',
  contains: ['ROTATED', 'ANGLE', 'TILTED', 'DEGREES', 'TEXT']
})

export const ocrMultiSizedText = createOcrTest('ocr-multi-sized-text', 'ocr-multi-sized-text.png', {
  validation: 'contains-all',
  contains: ['SMALL', 'MEDIUM', 'LARGE']
})

export const ocrMultipleFonts = createOcrTest('ocr-multiple-fonts', 'ocr-multiple-fonts.png', {
  validation: 'contains-all',
  contains: ['SANS', 'SERIF', 'BOLD']
})

export const ocrStats = createOcrTest(
  'ocr-stats',
  'ocr-simple-test-png.png',
  { validation: 'type', expectedType: 'array' },
  undefined,
  60000,
  ['smoke']
)

export const ocrStreamingStats = createOcrTest(
  'ocr-streaming-stats',
  'ocr-simple-test-png.png',
  { validation: 'type', expectedType: 'array' },
  { streaming: true },
  60000
)

export const ocrBlockStructure = createOcrTest(
  'ocr-block-structure',
  'ocr-simple-test-png.png',
  { validation: 'type', expectedType: 'array' },
  undefined,
  60000,
  ['smoke']
)

export const ocrStreamingBlockStructure = createOcrTest(
  'ocr-streaming-block-structure',
  'ocr-simple-test-png.png',
  { validation: 'type', expectedType: 'array' },
  { streaming: true },
  60000
)

export const ocrLogoBlockStructure = createOcrTest('ocr-logo-block-structure', 'logo.png', {
  validation: 'type',
  expectedType: 'array'
})

export const ocrParagraphStats = createOcrTest(
  'ocr-paragraph-stats',
  'ocr-simple-test-png.png',
  { validation: 'type', expectedType: 'array' },
  { paragraph: true },
  60000
)

export const ocrParagraphBlockStructure = createOcrTest(
  'ocr-paragraph-block-structure',
  'ocr-simple-test-png.png',
  { validation: 'type', expectedType: 'array' },
  { paragraph: true },
  60000
)

export const ocrParagraphStreaming = createOcrTest(
  'ocr-paragraph-streaming',
  'ocr-simple-test-png.png',
  { validation: 'contains-any', contains: ['OCR', 'text', 'testing', 'Type', 'enter'] },
  { streaming: true, paragraph: true },
  60000
)

// DocTR pipeline coverage (QVAC-22514): every other OCR test runs the
// EasyOCR `ocr` resource (OCR_LATIN), which was the only pipeline with e2e
// coverage when the DocTR load path shipped broken in @qvac/sdk 0.15.0.
// These run against the `doctr` resource — OCR_DOCTR with no explicit
// pipelineType/detectorModelSrc — so the auto pipelineType inference and
// DBNet detector derivation stay exercised end to end.
export const ocrDoctrBasicPng = createOcrTest(
  'ocr-doctr-basic-png',
  'ocr-simple-test-png.png',
  {
    validation: 'contains-any',
    contains: ['OCR', 'text', 'testing', 'implementation', 'recognize', 'Type', 'enter']
  },
  { resource: 'doctr' },
  90000,
  ['smoke']
)

export const ocrDoctrBlockStructure = createOcrTest(
  'ocr-doctr-block-structure',
  'ocr-simple-test-png.png',
  { validation: 'type', expectedType: 'array' },
  { resource: 'doctr' },
  60000
)

export const ocrTests = [
  ocrBasicPng,
  ocrBasicJpg,
  ocrStreaming,
  ocrParagraphMode,
  ocrSignImage,
  ocrLogoImage,
  ocrChartImage,
  ocrNoTextImage,
  ocrLargeImage,
  ocrSmallImage,
  ocrLowQuality,
  ocrMixedLanguage,
  ocrSingleLanguage,
  ocrBlurryText,
  ocrHorizontallyInverted,
  ocrVerticallyInverted,
  ocrMisalignedText,
  ocrMultiSizedText,
  ocrMultipleFonts,
  ocrStats,
  ocrStreamingStats,
  ocrParagraphStats,
  ocrBlockStructure,
  ocrStreamingBlockStructure,
  ocrLogoBlockStructure,
  ocrParagraphBlockStructure,
  ocrParagraphStreaming,
  ocrDoctrBasicPng,
  ocrDoctrBlockStructure
]
