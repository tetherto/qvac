import type { TestDefinition } from '@tetherto/qvac-test-suite';

const createOcrTest = (
  testId: string,
  imageFileName: string,
  expectation:
    | { validation: 'contains-all' | 'contains-any'; contains: string[] }
    | { validation: 'type'; expectedType: 'string' | 'number' | 'array' | 'embedding' }
    | { validation: 'regex'; pattern: string },
  options?: { streaming?: boolean; paragraph?: boolean },
  estimatedDurationMs: number = 30000
): TestDefinition => ({
  testId,
  params: { imageFileName, timeout: 300000, ...options },
  expectation,
  metadata: { category: 'ocr', dependency: 'ocr', estimatedDurationMs },
});

// Basic OCR tests with the simple test image (PNG format)
export const ocrBasicPng = createOcrTest(
  'ocr-basic-png',
  'ocr-simple-test.png',
  {
    validation: 'contains-any',
    contains: ['OCR', 'text', 'testing', 'implementation', 'recognize', 'Type', 'enter'],
  },
  undefined,
  60000
);

// Basic OCR tests with the simple test image (JPG format)
export const ocrBasicJpg = createOcrTest(
  'ocr-basic-jpg',
  'ocr-simple-test.jpg',
  {
    validation: 'contains-any',
    contains: ['OCR', 'text', 'testing', 'implementation', 'recognize', 'Type', 'enter'],
  },
  undefined,
  60000
);

// Test streaming mode
export const ocrStreaming = createOcrTest(
  'ocr-streaming',
  'ocr-simple-test.png',
  { validation: 'type', expectedType: 'array' },
  { streaming: true },
  60000
);

// Test paragraph mode option
export const ocrParagraphMode = createOcrTest(
  'ocr-paragraph-mode',
  'ocr-simple-test.png',
  { validation: 'type', expectedType: 'array' },
  { paragraph: true },
  60000
);

// Test with existing images in shared-test-data
export const ocrSignImage = createOcrTest('ocr-sign-image', 'sign.jpg', { validation: 'type', expectedType: 'array' });

export const ocrLogoImage = createOcrTest('ocr-logo-image', 'logo.png', { validation: 'type', expectedType: 'array' });

export const ocrChartImage = createOcrTest('ocr-chart-image', 'chart.jpg', { validation: 'type', expectedType: 'array' });

// Test with image that has no text (should return empty or minimal results)
export const ocrNoTextImage = createOcrTest('ocr-no-text-image', 'cat.jpg', {
  validation: 'type',
  expectedType: 'array',
});

export const ocrSunsetImage = createOcrTest('ocr-sunset-image', 'sunset.jpg', {
  validation: 'type',
  expectedType: 'array',
});

// Test with different image sizes
export const ocrLargeImage = createOcrTest(
  'ocr-large-image',
  'large-4k.jpg',
  { validation: 'type', expectedType: 'array' },
  undefined,
  120000 // Longer timeout for large image
);

export const ocrSmallImage = createOcrTest('ocr-small-image', 'small-64.jpg', {
  validation: 'type',
  expectedType: 'array',
});

// Test with low quality image
export const ocrLowQuality = createOcrTest('ocr-low-quality', 'low-quality.jpg', {
  validation: 'type',
  expectedType: 'array',
});

// Test with multi-language images (if available)
export const ocrMixedLanguage = createOcrTest('ocr-mixed-language', 'mixed-language-store.jpg', {
  validation: 'type',
  expectedType: 'array',
});

export const ocrTests = [
  ocrBasicPng,
  ocrBasicJpg,
  ocrStreaming,
  ocrParagraphMode,
  ocrSignImage,
  ocrLogoImage,
  ocrChartImage,
  ocrNoTextImage,
  ocrSunsetImage,
  ocrLargeImage,
  ocrSmallImage,
  ocrLowQuality,
  ocrMixedLanguage,
];

