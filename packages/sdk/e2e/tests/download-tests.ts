import type { TestDefinition } from '@qvac/test-suite'

export const downloadCancelIsolation: TestDefinition = {
  testId: 'download-cancel-isolation',
  params: { cancelAtPercent: 1 },
  // expectation is ignored in test executor, it does validation in the executor itself.
  expectation: { validation: 'function', fn: () => true },
  suites: ['smoke'],
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 180000
  }
}

// A single-file LFS GGUF on the Hub. downloadAsset over its https URL verifies
// the streamed bytes against the Hub SHA-256, so a resolved download is proof
// the Hugging Face verification path accepts genuine Hub content.
export const downloadHuggingFaceVerify: TestDefinition = {
  testId: 'download-hf-verify',
  params: {
    assetUrl:
      'https://huggingface.co/qvac/VisionPsy-Nano-460M-Flash-GGUFs/resolve/main/mmproj-visionpsy-nano-460m-flash-q8.gguf'
  },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 180000
  }
}

export const downloadTests = [downloadCancelIsolation, downloadHuggingFaceVerify]
