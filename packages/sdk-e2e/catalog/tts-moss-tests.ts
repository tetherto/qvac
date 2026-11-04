import type { Step, TestDefinition } from '@qvac/test-suite'

const callParams = {
  text: '$params.text?',
  stream: '$params.stream?',
  seconds: '$params.seconds?',
  steps: '$params.steps?',
  audio: '$params.audio?',
  sampleRate: '$params.sampleRate?',
  textReply: '$params.textReply?',
  greedy: '$params.greedy?',
  messages: '$params.messages?'
}

function synthesis(dependency: string): Step[] {
  return [
    { useModel: { deps: [dependency], as: 'model' } },
    {
      call: {
        method: 'textToSpeech',
        collect: 'pcm',
        params: { modelId: '$model', ...callParams },
        as: 'run'
      }
    }
  ]
}

function errorSteps(): Step[] {
  return [
    {
      callError: {
        method: 'textToSpeech',
        collect: 'pcm',
        params: { modelId: 'validation-only', ...callParams },
        as: 'error'
      }
    },
    { project: { from: '$error', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ]
}

function textReplySteps(): Step[] {
  return [
    ...synthesis('tts-moss-speech'),
    { project: { from: '$run', path: 'text', as: 'text' } },
    { assert: { on: '$text', use: 'expectation' } },
    { project: { from: '$run', path: 'pcm', as: 'pcm' } },
    { assert: { on: '$pcm', named: 'emptyArray' } }
  ]
}

// Duration and nonzero PCM are the strongest stable assertions for sound effects;
// waveform identity and semantic audio quality vary across native backends.
export const ttsMossTests: TestDefinition[] = [
  {
    testId: 'tts-moss-sfx-default-stream',
    params: { text: 'Heavy rain falling on a tin roof.', seconds: 2, steps: 4 },
    expectation: { validation: 'type', expectedType: 'array' },
    metadata: { category: 'tts', dependency: 'tts-moss-sfx', estimatedDurationMs: 120000 },
    steps: [
      ...synthesis('tts-moss-sfx'),
      { assert: { on: '$run', named: 'mossSoundEffect', with: { seconds: 2 } } }
    ]
  },
  {
    testId: 'tts-moss-sfx-short-duration',
    params: { text: 'A short bell sound.', seconds: 0.1, steps: 4, stream: false },
    expectation: { validation: 'type', expectedType: 'array' },
    metadata: { category: 'tts', dependency: 'tts-moss-sfx', estimatedDurationMs: 120000 },
    steps: [
      ...synthesis('tts-moss-sfx'),
      { assert: { on: '$run', named: 'mossSoundEffect', with: { seconds: 0.1 } } }
    ]
  },
  {
    testId: 'tts-moss-sfx-invalid-duration',
    params: { text: 'Rain.', seconds: 31 },
    expectation: { validation: 'throws-error', errorContains: 'seconds' },
    metadata: { category: 'tts', dependency: 'none', estimatedDurationMs: 1000 },
    steps: errorSteps()
  },
  {
    testId: 'tts-moss-speech-default-stream',
    params: { text: 'What is two plus two? Answer briefly.', textReply: true, greedy: true },
    expectation: { validation: 'contains-any', contains: ['four', 'Four', '4'] },
    metadata: { category: 'tts', dependency: 'tts-moss-speech', estimatedDurationMs: 120000 },
    steps: textReplySteps()
  },
  {
    testId: 'tts-moss-speech-conversation',
    params: {
      text: 'Add one to that number. Answer briefly.',
      messages: [
        { role: 'user', text: 'Remember the number one.' },
        { role: 'assistant', text: 'The number is one.' }
      ],
      stream: false,
      textReply: true,
      greedy: true
    },
    expectation: { validation: 'contains-any', contains: ['two', 'Two', '2'] },
    metadata: { category: 'tts', dependency: 'tts-moss-speech', estimatedDurationMs: 120000 },
    steps: textReplySteps()
  },
  {
    testId: 'tts-moss-speech-invalid-pcm',
    params: { audio: [2], sampleRate: 16000 },
    expectation: { validation: 'throws-error', errorContains: 'audio' },
    metadata: { category: 'tts', dependency: 'none', estimatedDurationMs: 1000 },
    steps: errorSteps()
  }
]
