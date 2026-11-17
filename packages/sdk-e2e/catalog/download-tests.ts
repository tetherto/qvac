// Download resilience, and why this file stays on its executors.
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

// A registry download cancelled without `clearCache` keeps its blocks, so the
// next download of the model starts from where it stopped. `resumeAtPercent`
// is the least the next download's first progress event may report.
export const downloadPauseResume: TestDefinition = {
  testId: 'download-pause-resume',
  params: { pauseAtPercent: 30, resumeAtPercent: 15 },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 180000
  }
}

// `cancel({ clearCache: true })` drops the blocks, so the next download starts over.
export const downloadCancelClearCache: TestDefinition = {
  testId: 'download-cancel-clear-cache',
  params: { pauseAtPercent: 30, restartBelowPercent: 10 },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 120000
  }
}

// `deleteCache({ modelSrc })` reclaims a paused download, so the next one starts over.
export const downloadDeleteCacheReclaim: TestDefinition = {
  testId: 'download-delete-cache-reclaim',
  params: { pauseAtPercent: 30, restartBelowPercent: 10 },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 120000
  }
}

export const downloadDeleteCacheWhileDownloading: TestDefinition = {
  testId: 'download-delete-cache-while-downloading',
  params: { errorContains: 'is downloading' },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 60000
  }
}

export const downloadDeleteCacheInvalidSrc: TestDefinition = {
  testId: 'download-delete-cache-invalid-src',
  params: {
    modelSrc: 'https://example.com/model.gguf',
    errorContains: 'Invalid deleteCache parameters'
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'download',
    dependency: 'none',
    estimatedDurationMs: 10000
  }
}

export const downloadTests = [
  downloadCancelIsolation,
  downloadHuggingFaceVerify,
  downloadPauseResume,
  downloadCancelClearCache,
  downloadDeleteCacheReclaim,
  downloadDeleteCacheWhileDownloading,
  downloadDeleteCacheInvalidSrc
]

// The tests without steps drive network faults through local HTTP fixtures, so each client needs
// its own body.
