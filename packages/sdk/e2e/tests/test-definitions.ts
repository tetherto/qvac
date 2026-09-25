// Real SDK tests
import type { Step, TestDefinition } from '@qvac/test-suite'
import { batchCompletionTests } from './batch-completion-tests.js'
import { completionTests } from './completion-tests.js'
import { transcriptionTests } from './transcription-tests.js'
import { transcribeStreamEventsTests } from './transcribe-stream-events-tests.js'
import { embeddingTests } from './embedding-tests.js'
import { ragTests } from './rag-tests.js'
import { vectorIndexTests } from './vector-index-tests.js'
import { translationIndicTransTests } from './translation-indictrans-tests.js'
import { translationBergamotTests } from './translation-bergamot-tests.js'
import { translationBergamotCacheTests } from './translation-bergamot-cache-tests.js'
import { translationLlmTests } from './translation-llm-tests.js'
import { modelInfoTests } from './model-info-tests.js'
import { kvCacheTests } from './kv-cache-tests.js'
import { kvCacheRestartTests } from './kv-cache-restart-tests.js'
import { errorTests } from './error-tests.js'
import { toolsTests } from './tools-tests.js'
import { ocrTests } from './ocr-tests.js'
import { classificationTests } from './classification-tests.js'
import { ttsTests } from './tts-tests.js'
import { configReloadTests } from './config-reload-tests.js'
import { loggingTests } from './logging-tests.js'
import { registryTests } from './registry-tests.js'
import { shardedModelTests } from './sharded-model-tests.js'
import { httpEmbeddingTests } from './http-embedding-tests.js'
import { parakeetTests } from './parakeet-tests.js'
import { parakeetStreamTests } from './parakeet-stream-tests.js'
import { bciTests } from './bci-tests.js'
import { visionTests } from './vision-tests.js'
import { downloadTests } from './download-tests.js'
import { downloadResilienceTests } from './download-resilience-tests.js'
import { diffusionTests } from './diffusion-tests.js'
import { worldTests } from './world-tests.js'
import { audioGenTests } from './audio-gen-tests.js'
import { finetuneTests } from './finetune-tests.js'
import { lifecycleTests } from './lifecycle-tests.js'
import { configTests } from './config-tests.js'
import { noLingeringBareTests } from './no-lingering-bare-tests.js'
import { wrongModelTests } from './wrong-model-tests.js'
import { multiGpuTests } from './multi-gpu-tests.js'
import { cancellationTests } from './cancellation-tests.js'
import { vlaTests } from './vla-tests.js'
import { pluginTests } from './plugin-tests.js'
import { snapStorageTests } from './snap-storage-tests.js'
import { systemResourcesTests } from './system-resources-tests.js'

/**
 * Loading the resource behind a key IS the load test.
 *
 * The executor hard-coded a model constant per test; the resource table holds
 * the same constant and the same config, so `useModel` drives the identical
 * load path and the definition stops carrying a per-client symbol it has no
 * way to name.
 */
const loadsResource = (dep: string): Step[] => [
  { useModel: { deps: [dep], as: 'modelId' } },
  { assert: { on: '$modelId', use: 'expectation' } }
]

/** `loadModel` driven directly, with the source taken from the resource table. */
const loadsWithConfig = (dep: string, modelConfig: Record<string, unknown>): Step[] => [
  { modelSource: { dep, as: 'src' } },
  {
    call: {
      method: 'loadModel',
      params: {
        modelSrc: '$src.modelSrc',
        modelType: '$src.modelType',
        modelConfig
      },
      as: 'loaded'
    }
  },
  { project: { from: '$loaded', path: 'modelId', as: 'modelId' } },
  { assert: { on: '$modelId', use: 'expectation' } }
]

// Model loading tests
export const modelLoadLlm: TestDefinition = {
  testId: 'model-load-llm',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: loadsResource('llm'),
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 60000
  }
}

export const modelLoadLlmLoadModeNone: TestDefinition = {
  testId: 'model-load-llm-load-mode-none',
  params: { loadMode: 'none' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: loadsWithConfig('llm', { verbosity: 0, ctx_size: 2048, load_mode: '$params.loadMode' }),
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 60000
  }
}

// Asserts the validation code, not the key name: a native --no-mmap error names it too.
export const modelLoadLlmLegacyNoMmapRejected: TestDefinition = {
  testId: 'model-load-llm-legacy-no-mmap-rejected',
  params: { noMmap: true },
  expectation: { validation: 'throws-error', errorContains: '50010' },
  steps: [
    { modelSource: { dep: 'llm', as: 'src' } },
    {
      callError: {
        method: 'loadModel',
        params: {
          modelSrc: '$src.modelSrc',
          modelType: '$src.modelType',
          modelConfig: { no_mmap: '$params.noMmap' }
        },
        as: 'err'
      }
    },
    // The code is on the error, not in its message -- and a native --no-mmap
    // complaint would mean the key reached the addon instead of failing SDK
    // validation, which is the regression this test exists for.
    {
      assert: {
        on: '$err',
        named: 'errorMatches',
        with: { code: '50010', messageNotMatching: 'invalid argument|--no-mmap' }
      }
    }
  ],
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 1000
  }
}

export const modelLoadEmbedding: TestDefinition = {
  testId: 'model-load-embedding',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: loadsResource('embeddings'),
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 60000
  }
}

export const modelLoadOcr: TestDefinition = {
  testId: 'model-load-ocr',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: loadsResource('ocr'),
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 90000
  }
}

// Loads OCR_DOCTR with no explicit pipelineType/detectorModelSrc — the
// gap that let QVAC-22514 ship: with only OCR_LATIN (EasyOCR) covered, the
// plugin could assume the EasyOCR pipeline for every recognizer and no e2e
// test noticed. This exercises the auto pipelineType: "doctr" inference and
// DBNet detector derivation on the load path.
export const modelLoadOcrDoctr: TestDefinition = {
  testId: 'model-load-ocr-doctr',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: loadsResource('doctr'),
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 90000
  }
}

export const modelLoadInvalid: TestDefinition = {
  testId: 'model-load-invalid',
  params: {
    modelType: 'llamacpp-completion',
    modelPath: '/invalid/path/nonexistent-model.gguf'
  },
  expectation: {
    validation: 'throws-error',
    errorContains: 'failed to locate'
  },
  suites: ['smoke'],
  steps: [
    {
      callError: {
        method: 'loadModel',
        params: { modelSrc: '$params.modelPath', modelType: '$params.modelType' },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 5000
  }
}

export const modelUnload: TestDefinition = {
  testId: 'model-unload',
  params: { shouldClearStorage: false },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: [
    { useModel: { deps: ['llm'], as: 'modelId' } },
    {
      call: {
        method: 'unloadModel',
        params: { modelId: '$modelId', clearStorage: '$params.shouldClearStorage' },
        as: 'unloaded'
      }
    },
    { assert: { on: '$modelId', use: 'expectation' } }
  ],
  metadata: { category: 'model', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const modelLoadConcurrent: TestDefinition = {
  testId: 'model-load-concurrent',
  params: {
    models: [
      { type: 'llamacpp-completion', constant: 'LLAMA_3_2_1B_INST_Q4_0' },
      { type: 'llamacpp-embedding', constant: 'GTE_LARGE_FP16' }
    ]
  },
  expectation: { validation: 'type', expectedType: 'array' },
  suites: ['smoke'],
  steps: [
    // The executor loaded the two in a loop; `useModel` with two deps is the
    // same sequence through the same table.
    { useModel: { deps: ['llm', 'embeddings'], as: 'modelIds' } },
    { assert: { on: '$modelIds', use: 'expectation' } }
  ],
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 120000,
    expectedCount: 2
  }
}

export const modelReloadLlm: TestDefinition = {
  testId: 'model-reload-llm',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  steps: loadsResource('llm'),
  metadata: {
    category: 'model',
    dependency: 'llm',
    estimatedDurationMs: 15000
  }
}

export const modelSwitchLlm: TestDefinition = {
  testId: 'model-switch-llm',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { useModel: { deps: ['llm'], as: 'first' } },
    { call: { method: 'unloadModel', params: { modelId: '$first' }, as: 'unloaded' } },
    { modelSource: { dep: 'llm', as: 'src' } },
    {
      call: {
        method: 'loadModel',
        params: {
          modelSrc: '$src.modelSrc',
          modelType: '$src.modelType',
          modelConfig: { verbosity: 0, ctx_size: 2048 }
        },
        as: 'loaded'
      }
    },
    { project: { from: '$loaded', path: 'modelId', as: 'modelId' } },
    { assert: { on: '$modelId', use: 'expectation' } }
  ],
  metadata: {
    category: 'model',
    dependency: 'llm',
    estimatedDurationMs: 90000
  }
}

export const modelReloadAfterError: TestDefinition = {
  testId: 'model-reload-after-error',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { useModel: { deps: ['llm'], as: 'first' } },
    { call: { method: 'unloadModel', params: { modelId: '$first' }, as: 'unloaded' } },
    { modelSource: { dep: 'llm', as: 'src' } },
    {
      call: {
        method: 'loadModel',
        params: {
          modelSrc: '$src.modelSrc',
          modelType: '$src.modelType',
          modelConfig: { verbosity: 0, ctx_size: 2048 }
        },
        as: 'loaded'
      }
    },
    { project: { from: '$loaded', path: 'modelId', as: 'modelId' } },
    { assert: { on: '$modelId', use: 'expectation' } }
  ],
  metadata: {
    category: 'model',
    dependency: 'llm',
    estimatedDurationMs: 70000
  }
}

export const modelLoadInferredType: TestDefinition = {
  testId: 'model-load-inferred-type',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: [
    { modelSource: { dep: 'llm', as: 'src' } },
    // Deliberately no modelType: the SDK must infer it from the descriptor.
    {
      call: {
        method: 'loadModel',
        params: { modelSrc: '$src.modelSrc', modelConfig: { verbosity: 0, ctx_size: 2048 } },
        as: 'loaded'
      }
    },
    { project: { from: '$loaded', path: 'modelId', as: 'modelId' } },
    { assert: { on: '$modelId', use: 'expectation' } }
  ],
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 60000
  }
}

export const modelLoadMissingTypeStringSrc: TestDefinition = {
  testId: 'model-load-missing-type-string-src',
  params: { modelPath: '/invalid/path/nonexistent-model.gguf' },
  expectation: {
    validation: 'throws-error',
    errorContains: 'modelType is required'
  },
  suites: ['smoke'],
  steps: [
    // A plain-string modelSrc with no modelType has nothing to infer from, so
    // the SDK must reject it rather than guess.
    {
      callError: {
        method: 'loadModel',
        params: { modelSrc: '$params.modelPath' },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 2000
  }
}

export const modelLifecycleNmt: TestDefinition = {
  testId: 'model-lifecycle-nmt',
  params: { text: 'Hello, how are you today?' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    { useModel: { deps: ['bergamot-en-fr'], as: 'first' } },
    {
      call: {
        method: 'translate',
        collect: 'text',
        params: { modelId: '$first', text: '$params.text', modelType: 'nmt', stream: false },
        as: 'run1'
      }
    },
    { project: { from: '$run1', path: 'text', as: 'text1' } },
    { assert: { on: '$text1', named: 'nonEmptyText' } },
    { call: { method: 'unloadModel', params: { modelId: '$first' }, as: 'unloaded' } },
    { modelSource: { dep: 'bergamot-en-fr', as: 'src' } },
    {
      call: {
        method: 'loadModel',
        params: {
          modelSrc: '$src.modelSrc',
          modelType: '$src.modelType',
          modelConfig: { engine: 'Bergamot', from: 'en', to: 'fr' }
        },
        as: 'loaded'
      }
    },
    { project: { from: '$loaded', path: 'modelId', as: 'second' } },
    {
      call: {
        method: 'translate',
        collect: 'text',
        params: {
          modelId: '$second',
          text: 'Good morning, nice to meet you.',
          modelType: 'nmt',
          stream: false
        },
        as: 'run2'
      }
    },
    { project: { from: '$run2', path: 'text', as: 'text2' } },
    { assert: { on: '$text2', named: 'nonEmptyText' } },
    { assert: { on: '$text2', use: 'expectation' } }
  ],
  metadata: {
    category: 'model',
    dependency: 'none',
    estimatedDurationMs: 180000
  }
}

// Export all tests as array
export const tests = [
  // Model tests (first section)
  modelLoadLlm,
  modelLoadLlmLoadModeNone,
  modelLoadLlmLegacyNoMmapRejected,
  modelLoadEmbedding,
  modelLoadOcr,
  modelLoadOcrDoctr,
  modelLoadInvalid,
  modelUnload,
  modelLoadConcurrent,
  modelReloadLlm,

  // Parakeet transcription tests
  ...parakeetTests,
  ...parakeetStreamTests,

  // Completion tests
  ...completionTests,
  ...batchCompletionTests,

  // Transcription tests
  ...transcriptionTests,

  // BCI (neural-signal) transcription tests
  ...bciTests,

  // transcribeStream VAD + endOfTurn event tests
  ...transcribeStreamEventsTests,

  // Embedding tests
  ...embeddingTests,

  // RAG tests
  ...ragTests,

  // Vector index tests (embed + TurboVec index, no RAG workspace)
  ...vectorIndexTests,

  // Translation: IndicTrans2 (EN↔HI)
  ...translationIndicTransTests,

  // Translation: Bergamot (EN→FR, EN→ES)
  ...translationBergamotTests,

  // Translation: Bergamot cache reload regression
  ...translationBergamotCacheTests,

  // Translation: LLM (open-vocabulary via from/to)
  ...translationLlmTests,

  // Sharded model tests
  ...shardedModelTests,

  // HTTP embedding tests
  ...httpEmbeddingTests,

  // Model info tests (includes both registry-side and loaded-model introspection)
  ...modelInfoTests,

  // KV cache tests
  ...kvCacheTests,
  ...kvCacheRestartTests,

  // Error tests
  ...errorTests,

  // Tools tests
  ...toolsTests,

  // OCR tests
  ...ocrTests,

  // Classification tests
  ...classificationTests,

  // TTS tests
  ...ttsTests,

  // Config reload tests
  ...configReloadTests,

  // Logging tests
  ...loggingTests,

  // Registry tests
  ...registryTests,

  // Vision tests
  ...visionTests,

  // Download tests (cancel isolation)
  ...downloadTests,

  // Download resilience: survive suspend/resume + network drop (QVAC-21225)
  ...downloadResilienceTests,

  // Diffusion tests
  ...diffusionTests,

  // ABot-World interactive world sessions (desktop GPU only)
  ...worldTests,

  // Audio generation tests (desktop-only; mobile skips via SkipExecutor)
  ...audioGenTests,

  // Finetuning tests
  ...finetuneTests,

  // Lifecycle tests (suspend/resume)
  ...lifecycleTests,

  // Registry-download config tests (retries + stream timeout)
  ...configTests,

  // Wrong-model error tests
  ...wrongModelTests,

  // No-lingering-bare regression tests
  ...noLingeringBareTests,

  // Multi-GPU config smoke (verifies split-mode and main-gpu flow through stack)
  ...multiGpuTests,

  // Typed cancel outcomes + KvCacheSession rollback e2e
  ...cancellationTests,

  // VLA (SmolVLA + π₀.₅) — runs on desktop; mobile skips via SkipExecutor
  // (see mobile/consumer.ts) because the GGUFs are too large for the
  // Device Farm infra (see note there).
  ...vlaTests,

  // Custom plugin system tests (custom-echo-plugin, error paths)
  ...pluginTests,

  // Strict Snap storage-path conformance
  ...snapStorageTests,

  // Local hardware capabilities and on-demand usage sampling
  ...systemResourcesTests,

  // Additional model tests
  modelSwitchLlm,
  modelReloadAfterError,
  modelLoadInferredType,
  modelLoadMissingTypeStringSrc,

  // NMT model lifecycle test
  modelLifecycleNmt
]
