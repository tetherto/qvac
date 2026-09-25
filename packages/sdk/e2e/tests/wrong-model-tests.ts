import type { TestDefinition } from '@qvac/test-suite'

export const wrongModelTranscribeOnLlm: TestDefinition = {
  testId: 'wrong-model-transcribe-on-llm',
  params: {},
  expectation: {
    validation: 'throws-error',
    errorContains: 'does not support transcribe'
  },
  suites: ['smoke'],
  // Four claims about one rejection: it names the operation that was asked
  // for, the type that was loaded, and a type that would have worked. A
  // message that only said "unsupported" would leave the caller no way
  // forward, which is the thing this test is actually protecting.
  steps: [
    { useModel: { deps: ['llm'], as: 'model' } },
    {
      callError: {
        method: 'transcribe',
        params: {
          modelId: '$model',
          audioChunk: '/tmp/anything-not-touched-because-we-throw-first.wav'
        },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } },
    { assert: { on: '$message', named: 'containsAll', with: { terms: ['transcribe'] } } },
    {
      assert: {
        on: '$message',
        named: 'containsAll',
        with: { terms: ['llamacpp-completion'] }
      }
    },
    {
      assert: {
        on: '$message',
        named: 'containsAny',
        with: { terms: ['whispercpp-transcription', 'parakeet-transcription'] }
      }
    }
  ],
  metadata: {
    category: 'wrong-model',
    dependency: 'llm',
    estimatedDurationMs: 5000
  }
}

export const wrongModelTests = [wrongModelTranscribeOnLlm]
