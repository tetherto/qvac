import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * Reload a loaded model's configuration in place.
 *
 * `modelId` without `modelSrc` is the hot-reload path: the model stays where
 * it is and only its config changes, which is why the id has to come back
 * unchanged. A reload that handed back a new id would mean the model was
 * dropped and rebuilt, and every handle the caller holds would be stale.
 */
const reloadSteps = (modelConfig: unknown, extra: Step[] = []): Step[] => [
  { useModel: { deps: ['whisper'], as: 'model' } },
  {
    call: {
      method: 'loadModel',
      params: {
        modelId: '$model',
        modelType: 'whispercpp-transcription',
        modelConfig
      },
      as: 'reloaded'
    }
  },
  { project: { from: '$reloaded', path: 'modelId', as: 'reloadedId' } },
  { compare: { left: '$reloadedId', right: '$model', named: 'equalStrings' } },
  ...extra
]

/** A reload the client is expected to refuse. */
const reloadRejects = (params: Record<string, unknown>): Step[] => [
  { useModel: { deps: ['whisper'], as: 'model' } },
  { callError: { method: 'loadModel', params, as: 'err' } },
  { assert: { on: '$err', named: 'errorIsStructured' } }
]

export const configReloadWhisperLanguage: TestDefinition = {
  testId: 'config-reload-whisper-language',
  params: { newLanguage: 'es' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: reloadSteps({ language: '$params.newLanguage' }),
  metadata: { category: 'config-reload', dependency: 'whisper', estimatedDurationMs: 15000 }
}

export const configReloadWhisperParams: TestDefinition = {
  testId: 'config-reload-whisper-params',
  params: { newConfig: { language: 'de', temperature: 0.2, suppress_blank: false } },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: reloadSteps('$params.newConfig'),
  metadata: { category: 'config-reload', dependency: 'whisper', estimatedDurationMs: 15000 }
}

export const configReloadPreservesId: TestDefinition = {
  testId: 'config-reload-preserves-id',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  // The id check is the body every reload test shares; this is the one whose
  // name says so.
  steps: reloadSteps({ language: 'fr' }),
  metadata: { category: 'config-reload', dependency: 'whisper', estimatedDurationMs: 15000 }
}

export const configReloadInvalidModelId: TestDefinition = {
  testId: 'config-reload-invalid-model-id',
  params: { invalidModelId: '0000000000000000' },
  expectation: { validation: 'throws-error', errorContains: '' },
  suites: ['smoke'],
  steps: reloadRejects({
    modelId: '$params.invalidModelId',
    modelType: 'whispercpp-transcription',
    modelConfig: { language: 'en' }
  }),
  metadata: { category: 'config-reload', dependency: 'whisper', estimatedDurationMs: 5000 }
}

export const configReloadWrongModelType: TestDefinition = {
  testId: 'config-reload-wrong-model-type',
  params: {},
  expectation: { validation: 'throws-error', errorContains: '' },
  // A whisper model reloaded as a completion model: the type has to be
  // checked against what is actually loaded, not taken on trust.
  steps: reloadRejects({
    modelId: '$model',
    modelType: 'llamacpp-completion',
    modelConfig: { ctx_size: 2048 }
  }),
  metadata: { category: 'config-reload', dependency: 'whisper', estimatedDurationMs: 5000 }
}

export const configReloadThenTranscribe: TestDefinition = {
  testId: 'config-reload-then-transcribe',
  params: { audioFileName: 'transcription-short-wav.wav', newLanguage: 'en' },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  // The model still works after the reload, which is the half a reload test
  // that only checked the id would miss.
  steps: reloadSteps({ language: '$params.newLanguage' }, [
    { asset: { kind: 'audio', file: '$params.audioFileName', form: 'path', as: 'audio' } },
    {
      call: {
        method: 'transcribe',
        params: { modelId: '$model', audioChunk: '$audio' },
        as: 'run'
      }
    },
    { project: { from: '$run', path: 'text', as: 'text' } },
    { assert: { on: '$text', named: 'nonEmptyText' } }
  ]),
  metadata: { category: 'config-reload', dependency: 'whisper', estimatedDurationMs: 30000 }
}

export const configReloadTests = [
  configReloadWhisperLanguage,
  configReloadWhisperParams,
  configReloadPreservesId,
  configReloadInvalidModelId,
  configReloadWrongModelType,
  configReloadThenTranscribe
]
