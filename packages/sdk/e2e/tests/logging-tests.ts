import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * Open a log stream, run something that logs, and read what came out.
 *
 * Three steps around the trigger rather than one call, because that is what
 * the executors were: the stream has to be open before the operation runs, the
 * cutoff is taken when the operation starts -- otherwise the buffered load
 * logs satisfy the target on their own -- and the read is bounded so a silent
 * addon fails rather than hangs.
 */
const logsAround = (
  open: Record<string, unknown>,
  trigger: Step[],
  options: { target?: number; timeoutMs?: number; before?: Step[] } = {}
): Step[] => [
  ...(options.before ?? []),
  { call: { method: 'loggingStreamOpen', params: open, as: 'logs' } },
  { project: { from: '$logs', path: 'streamId', as: 'streamId' } },
  { call: { method: 'loggingStreamMark', params: { streamId: '$streamId' } } },
  ...trigger,
  {
    call: {
      method: 'loggingStreamCollect',
      params: {
        streamId: '$streamId',
        target: options.target ?? 1,
        timeoutMs: options.timeoutMs ?? 5000
      },
      as: 'collected'
    }
  },
  { project: { from: '$collected', path: 'entries', as: 'entries' } }
]

/** Closes the log stream, on both paths. */
const closeLogStream: Step[] = [
  { call: { method: 'loggingStreamClose', params: { streamId: '$streamId?' } } }
]

/** The completion the logging tests use to make an addon say something. */
const completionTrigger: Step[] = [
  {
    call: {
      method: 'completion',
      collect: 'text',
      params: {
        modelId: '$model',
        history: [{ role: 'user', content: 'Logging test' }],
        stream: false,
        generationParams: { predict: 20 }
      },
      as: 'triggered'
    }
  }
]

/** The `llm` addon, triggered through its own public call. */
const llmLogSteps: Step[] = logsAround({ id: '$model' }, completionTrigger, {
  timeoutMs: 8000,
  before: [{ useModel: { deps: ['llm'], as: 'model' } }]
})

/** The `embed` addon, triggered through its own public call. */
const embedLogSteps: Step[] = logsAround(
  { id: '$model' },
  [{ call: { method: 'embed', params: { modelId: '$model', text: 'test' }, as: 'triggered' } }],
  { timeoutMs: 8000, before: [{ useModel: { deps: ['embeddings'], as: 'model' } }] }
)

/** The `tts` addon, triggered through its own public call. */
const ttsLogSteps: Step[] = logsAround(
  { id: '$model' },
  [
    {
      call: {
        method: 'textToSpeech',
        collect: 'pcm',
        params: { modelId: '$model', text: 'Hi', inputType: 'text', stream: false },
        as: 'triggered'
      }
    }
  ],
  { timeoutMs: 8000, before: [{ useModel: { deps: ['tts-supertonic'], as: 'model' } }] }
)

/** The `nmt` addon, triggered through its own public call. */
const nmtLogSteps: Step[] = logsAround(
  { id: '$model' },
  [
    {
      call: {
        method: 'translate',
        collect: 'text',
        params: {
          modelId: '$model',
          text: 'Hello world',
          modelType: 'nmtcpp-translation',
          stream: false
        },
        as: 'triggered'
      }
    }
  ],
  { timeoutMs: 8000, before: [{ useModel: { deps: ['bergamot-en-fr'], as: 'model' } }] }
)

/** The `diffusion` addon, triggered through its own public call. */
const diffusionLogSteps: Step[] = logsAround(
  { id: '$model' },
  [
    {
      call: {
        method: 'diffusion',
        collect: 'all',
        params: { modelId: '$model', prompt: 'a red square', width: 256, height: 256, steps: 1 },
        as: 'triggered'
      }
    }
  ],
  { timeoutMs: 8000, before: [{ useModel: { deps: ['diffusion'], as: 'model' } }] }
)

/** The `whisper` addon, triggered through its own public call. */
const whisperLogSteps: Step[] = logsAround(
  { id: '$model' },
  [
    { asset: { kind: 'audio', file: '$params.audioFileName', form: 'path', as: 'audio' } },
    {
      call: {
        method: 'transcribe',
        params: { modelId: '$model', audioChunk: '$audio' },
        as: 'triggered'
      }
    }
  ],
  { timeoutMs: 8000, before: [{ useModel: { deps: ['whisper'], as: 'model' } }] }
)

/** The `parakeet` addon, triggered through its own public call. */
const parakeetLogSteps: Step[] = logsAround(
  { id: '$model' },
  [
    { asset: { kind: 'audio', file: '$params.audioFileName', form: 'path', as: 'audio' } },
    {
      call: {
        method: 'transcribe',
        params: { modelId: '$model', audioChunk: '$audio' },
        as: 'triggered'
      }
    }
  ],
  { timeoutMs: 8000, before: [{ useModel: { deps: ['parakeet-tdt'], as: 'model' } }] }
)

/** The `ocr` addon, triggered through its own public call. */
const ocrLogSteps: Step[] = logsAround(
  { id: '$model' },
  [
    { asset: { kind: 'image', file: '$params.imageFileName', form: 'path', as: 'image' } },
    {
      call: {
        method: 'ocr',
        collect: 'text',
        params: { modelId: '$model', image: '$image' },
        as: 'triggered'
      }
    }
  ],
  { timeoutMs: 8000, before: [{ useModel: { deps: ['ocr'], as: 'model' } }] }
)

export const addonLoggingLlm: TestDefinition = {
  testId: 'addon-logging-llm',
  params: { handler: 'addon-logging', trigger: 'llm' },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: [
    ...llmLogSteps,
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', dependency: 'llm', estimatedDurationMs: 10000 }
}

export const addonLoggingEmbed: TestDefinition = {
  testId: 'addon-logging-embed',
  params: { handler: 'addon-logging', trigger: 'embed' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    ...embedLogSteps,
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', dependency: 'embeddings', estimatedDurationMs: 10000 }
}

export const addonLoggingWhisper: TestDefinition = {
  testId: 'addon-logging-whisper',
  params: {
    handler: 'addon-logging',
    trigger: 'whisper',
    audioFileName: 'transcription-short-wav.wav'
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    ...whisperLogSteps,
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', dependency: 'whisper', estimatedDurationMs: 20000 }
}

export const addonLoggingParakeet: TestDefinition = {
  testId: 'addon-logging-parakeet',
  params: {
    handler: 'addon-logging',
    trigger: 'parakeet',
    audioFileName: 'transcription-short-wav.wav'
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    ...parakeetLogSteps,
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', dependency: 'parakeet-tdt', estimatedDurationMs: 20000 }
}

export const addonLoggingOcr: TestDefinition = {
  testId: 'addon-logging-ocr',
  params: { handler: 'addon-logging', trigger: 'ocr', imageFileName: 'small-64.jpg' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    ...ocrLogSteps,
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', dependency: 'ocr', estimatedDurationMs: 30000 }
}

export const addonLoggingTts: TestDefinition = {
  testId: 'addon-logging-tts',
  params: { handler: 'addon-logging', trigger: 'tts' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    ...ttsLogSteps,
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', dependency: 'tts-supertonic', estimatedDurationMs: 20000 }
}

export const addonLoggingNmt: TestDefinition = {
  testId: 'addon-logging-nmt',
  params: { handler: 'addon-logging', trigger: 'nmt' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    ...nmtLogSteps,
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', dependency: 'bergamot-en-fr', estimatedDurationMs: 15000 }
}

export const addonLoggingDiffusion: TestDefinition = {
  testId: 'addon-logging-diffusion',
  params: { handler: 'addon-logging', trigger: 'diffusion' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    ...diffusionLogSteps,
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', dependency: 'diffusion', estimatedDurationMs: 120000 }
}

export const addonLoggingSdkServer: TestDefinition = {
  testId: 'addon-logging-sdk-server',
  params: { handler: 'addon-logging' },
  expectation: { validation: 'type', expectedType: 'string' },
  // No trigger: SDK-server logs flow with any RPC, and the registry listing is
  // the cheapest one to make.
  steps: [
    ...logsAround({}, [{ call: { method: 'modelRegistryList', as: 'triggered' } }], {
      timeoutMs: 8000
    }),
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', target: 'sdk-server', estimatedDurationMs: 10000 },
  // SDK-server entries are not worker logs: the JS client pipes the worker's
  // own stderr into a stream under the SDK namespace itself
  // (`client/rpc/node-rpc-client.ts`). The Python client never reads the
  // worker's stderr, so `loggingStream(SDK_LOG_ID)` there only ever carries
  // what the worker sends over the wire, and this stream stays empty. The
  // vocabulary is not the blocker; the client is missing the capability.
  skip: {
    reason:
      'the Python client cannot run this: SDK-server log entries come from the client capturing the worker process stderr, which the JS client does and the Python client does not, so its SDK log stream is always empty',
    platforms: ['desktop-python']
  }
}

export const addonLoggingInvalidModelId: TestDefinition = {
  testId: 'addon-logging-invalid-model-id',
  params: { handler: 'invalid-model-id', invalidModelId: 'non-existent-model-xyz-12345' },
  expectation: { validation: 'type', expectedType: 'string' },
  // The absence is the assertion: a stream opened on a model that does not
  // exist must stay empty rather than leak somebody else's logs. The window
  // has to elapse in full here, since there is nothing to arrive early.
  steps: [
    ...logsAround({ id: '$params.invalidModelId' }, [], { target: 3, timeoutMs: 3000 }),
    { assert: { on: '$entries', named: 'lengthIs', with: { length: 0 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', estimatedDurationMs: 5000 }
}

export const addonLoggingDuringInference: TestDefinition = {
  testId: 'addon-logging-during-inference',
  params: { handler: 'during-inference', streaming: true, operationCount: 1 },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: [
    ...logsAround({ id: '$model' }, completionTrigger, {
      target: 5,
      timeoutMs: 10000,
      before: [{ useModel: { deps: ['llm'], as: 'model' } }]
    }),
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'addon-logging', dependency: 'llm', estimatedDurationMs: 15000 }
}

/**
 * The `logging-*` group, and what these tests actually check.
 *
 * Seven of the nine route to the executor's `during-inference` handler, which
 * reads exactly three parameters: `operationCount`, `streaming` and
 * `verifyTimestamps`. Everything else these definitions carry --
 * `logLevel: 'invalid_level_xyz'`, `levelSequence`, `addonLogLevels`,
 * `triggerLongLog` with `expectedMinLength`, `enabledNamespaces` /
 * `disabledNamespaces` -- is never read by any client. No level is ever set,
 * no namespace is ever filtered, no long message is ever triggered.
 *
 * So five of them are the same test under five names. They are migrated as
 * what they run rather than as what they are called, because writing the
 * missing halves now would be inventing tests under existing ids -- a
 * decision about coverage, not a migration. The ids are left alone so the gap
 * stays visible.
 */
const duringInference = (options: { operationCount?: number; checks?: Step[] } = {}): Step[] => {
  const runs: Step[] = []
  for (let i = 0; i < (options.operationCount ?? 1); i++) {
    runs.push({
      call: {
        method: 'completion',
        collect: 'text',
        params: {
          modelId: '$model',
          history: [{ role: 'user', content: `Logging test ${i + 1}` }],
          stream: true,
          generationParams: { predict: 20 }
        },
        as: `triggered${i}`
      }
    })
  }
  return [
    ...logsAround({ id: '$model' }, runs, {
      target: 5,
      timeoutMs: 10000,
      before: [{ useModel: { deps: ['llm'], as: 'model' } }]
    }),
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } },
    ...(options.checks ?? [])
  ]
}

export const loggingInvalidLevel: TestDefinition = {
  testId: 'logging-invalid-level',
  params: { handler: 'during-inference', logLevel: 'invalid_level_xyz' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: duringInference(),
  finally: closeLogStream,
  metadata: { category: 'logging', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const loggingRapidLevelSwitch: TestDefinition = {
  testId: 'logging-rapid-level-switch',
  params: {
    handler: 'during-inference',
    levelSequence: ['debug', 'warn', 'error', 'info', 'debug', 'off', 'warn'],
    switchDelayMs: 50
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: duringInference(),
  finally: closeLogStream,
  metadata: { category: 'logging', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const loggingConcurrentOperations: TestDefinition = {
  testId: 'logging-concurrent-operations',
  params: { handler: 'concurrent', operations: ['completion', 'embedding'], runConcurrently: true },
  expectation: { validation: 'type', expectedType: 'string' },
  // Two operations in flight against two different addons. `start` is what
  // makes it the concurrent test its name claims: the executor fired both with
  // `Promise.allSettled`, and running them one after another would prove
  // nothing about the log stream under load.
  steps: [
    ...logsAround(
      { id: '$model' },
      [
        {
          start: {
            method: 'completion',
            collect: 'text',
            params: {
              modelId: '$model',
              history: [{ role: 'user', content: 'Test concurrent logging' }],
              stream: false,
              generationParams: { predict: 20 }
            },
            as: 'completing'
          }
        },
        {
          start: {
            method: 'embed',
            params: { modelId: '$embeddingModel', text: 'test concurrent' },
            as: 'embedding'
          }
        },
        { settle: { of: '$completing', as: 'completed' } },
        { settle: { of: '$embedding', as: 'embedded' } }
      ],
      {
        target: 5,
        timeoutMs: 10000,
        before: [
          { useModel: { deps: ['llm', 'embeddings'], as: 'models' } },
          { project: { from: '$models', path: '[0]', as: 'model' } },
          { project: { from: '$models', path: '[1]', as: 'embeddingModel' } }
        ]
      }
    ),
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'logging', dependency: 'llm', estimatedDurationMs: 15000 }
}

export const loggingPersistAcrossReload: TestDefinition = {
  testId: 'logging-persist-across-reload',
  params: { handler: 'reload', setLogLevel: 'debug', unloadModel: true, reloadModel: true },
  expectation: { validation: 'type', expectedType: 'string' },
  // The stream is opened on the model that exists *after* the reload, which
  // is the whole point: logs have to keep flowing from a freshly loaded model,
  // not only from the one that was up when the process started.
  steps: [
    ...logsAround({ id: '$model' }, completionTrigger, {
      target: 5,
      timeoutMs: 10000,
      before: [
        { useModel: { deps: ['llm'], as: 'original' } },
        { call: { method: 'evictResource', params: { dep: 'llm' } } },
        { useModel: { deps: ['llm'], as: 'model' } }
      ]
    }),
    { assert: { on: '$entries', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  finally: closeLogStream,
  metadata: { category: 'logging', dependency: 'llm', estimatedDurationMs: 15000 }
}

export const loggingAllAddonsSilent: TestDefinition = {
  testId: 'logging-all-addons-silent',
  params: {
    handler: 'during-inference',
    addonLogLevels: { llm: 'off', embedding: 'off', whisper: 'off', tts: 'off', sdk: 'off' }
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: duringInference(),
  finally: closeLogStream,
  metadata: { category: 'logging', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const loggingLongMessage: TestDefinition = {
  testId: 'logging-long-message',
  params: { handler: 'during-inference', triggerLongLog: true, expectedMinLength: 1000 },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: duringInference(),
  finally: closeLogStream,
  metadata: { category: 'logging', dependency: 'llm', estimatedDurationMs: 10000 }
}

export const loggingStreamingStress: TestDefinition = {
  testId: 'logging-streaming-stress',
  params: {
    handler: 'during-inference',
    logLevel: 'debug',
    performMultipleOperations: true,
    operationCount: 3
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: duringInference({ operationCount: 3 }),
  finally: closeLogStream,
  metadata: { category: 'logging', dependency: 'llm', estimatedDurationMs: 20000 }
}

export const loggingTimestampAccuracy: TestDefinition = {
  testId: 'logging-timestamp-accuracy',
  params: { handler: 'during-inference', logLevel: 'debug', verifyTimestamps: true },
  expectation: { validation: 'type', expectedType: 'string' },
  // The one `during-inference` parameter the executor did read: entries
  // arriving out of order would make every time-ordered read of a log stream
  // wrong, without any single entry looking wrong.
  steps: duringInference({
    checks: [
      {
        assert: {
          on: '$entries',
          named: 'sortedAscendingBy',
          with: { field: 'timestamp', minimum: 2 }
        }
      }
    ]
  }),
  finally: closeLogStream,
  metadata: { category: 'logging', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const loggingNamespaceFilter: TestDefinition = {
  testId: 'logging-namespace-filter',
  params: {
    handler: 'during-inference',
    enabledNamespaces: ['llamacpp:llm'],
    disabledNamespaces: ['llamacpp:embed', 'whispercpp', 'tts']
  },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: duringInference(),
  finally: closeLogStream,
  metadata: { category: 'logging', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const loggingTests = [
  addonLoggingLlm,
  addonLoggingEmbed,
  addonLoggingWhisper,
  addonLoggingParakeet,
  addonLoggingOcr,
  addonLoggingTts,
  addonLoggingNmt,
  addonLoggingDiffusion,
  addonLoggingSdkServer,
  addonLoggingInvalidModelId,
  addonLoggingDuringInference,
  loggingInvalidLevel,
  loggingRapidLevelSwitch,
  loggingConcurrentOperations,
  loggingPersistAcrossReload,
  loggingAllAddonsSilent,
  loggingLongMessage,
  loggingStreamingStress,
  loggingTimestampAccuracy,
  loggingNamespaceFilter
]
