/**
 * Tests for parakeet's duplex `transcribeStream` API.
 *
 * Exercises the long-lived `parakeet::StreamSession` path on the
 * server: audio is fed in over the request half of a duplex RPC,
 * per-chunk text segments come back over the response half, and EOU
 * boundary events surface as synthetic `{ type: "endOfTurn" }` frames.
 *
 * Parakeet does NOT emit standalone `vad` events — the
 * `parakeetStreamingConfig.emitEnergyVad` knob is purely an internal
 * hint to parakeet-cpp's segmentation. Whisper is the only engine
 * that surfaces `vad` events.
 */
import type { Step, TestDefinition } from '@qvac/test-suite'

// The duplex runner feeds raw PCM directly into the parakeet session
// (no FFmpegDecoder hop, unlike `transcribe()`), so the fixture itself
// must already be 16 kHz mono — parakeet's expected sample rate. The
// `transcription-short-wav.wav` fixture is 48 kHz stereo and would be
// rejected by the runner's `sampleRate !== 16000` precondition.
const AUDIO_FIXTURE = 'diarization-sample-16k.wav'

// The EOU detector fires `<EOU>` based on sentence-final / turn-boundary
// linguistic patterns from its small ASR head (see the addon's own
// `eou-streaming.test.js` regression note). `diarization-sample-16k.wav`
// is continuous multi-speaker overlap and produces transcript text but no
// clean turn boundaries, so the model emits zero `isEndOfTurn` segments
// against it. `two-speakers-16k.wav` is the same format (16 kHz mono) but
// is alternating two-speaker conversation — exactly the stimulus the EOU
// head is trained on — so at least one boundary surfaces reliably.
const EOU_AUDIO_FIXTURE = 'two-speakers-16k.wav'

/**
 * Opens a duplex session, feeds the fixture in paced chunks, ends the input
 * and reads the events out.
 *
 * Every step here was a line in the runner; what they have in common is that
 * the session is named by an id rather than held, which is what lets a client
 * with a different session object run the same body.
 */
const streamSteps = (
  dependency: string,
  checks: Step[],
  drain: Record<string, unknown> = {}
): Step[] => [
  // The dependency is an argument, not a `$ref`: `useModel.deps` names
  // resource keys the eviction guard reads before the body runs, so it has to
  // be readable without executing anything.
  { useModel: { deps: [dependency], as: 'model' } },
  { asset: { kind: 'audio', file: '$params.audioFileName', as: 'audio' } },
  {
    call: {
      method: 'transcribeStreamOpen',
      params: {
        modelId: '$model',
        parakeetStreamingConfig: {
          chunkMs: '$params.chunkMs',
          emitPartials: '$params.emitPartials?'
        }
      },
      as: 'session'
    }
  },
  { project: { from: '$session', path: 'sessionId', as: 'sessionId' } },
  {
    call: {
      method: 'transcribeStreamWrite',
      params: {
        sessionId: '$sessionId',
        audio: '$audio',
        chunkMs: '$params.chunkMs',
        trailingSilenceMs: '$params.trailingSilenceMs?'
      }
    }
  },
  { call: { method: 'transcribeStreamEnd', params: { sessionId: '$sessionId' } } },
  {
    call: {
      method: 'transcribeStreamDrain',
      collect: 'events',
      params: { sessionId: '$sessionId', ...drain },
      as: 'drained'
    }
  },
  { project: { from: '$drained', path: 'events', as: 'events' } },
  ...checks
]

/**
 * Parakeet's happy path: transcript text came out, and no standalone `vad`
 * events -- those are the whisper variant, and parakeet emitting them would
 * mean the conversation decoder had picked the wrong branch.
 */
const HAPPY_EVENTS: Step[] = [
  {
    assert: {
      on: '$events',
      named: 'eventTypeCounts',
      with: { atLeast: { text: 1 }, absent: ['vad'] }
    }
  }
]

/** The session reported how much audio it actually processed. */
const HAPPY_STATS: Step[] = [
  { project: { from: '$drained', path: 'stats', as: 'stats' } },
  { assert: { on: '$stats', named: 'timingStatsPresent', with: { field: 'audioDuration' } } }
]

/** Closes whatever session the body opened, on both paths. */
const destroySession: Step[] = [
  { call: { method: 'transcribeStreamDestroy', params: { sessionId: '$sessionId?' } } },
  { call: { method: 'transcribeStreamDestroy', params: { sessionId: '$secondSessionId?' } } }
]

export const parakeetStreamHappy: TestDefinition = {
  testId: 'parakeet-stream-happy',
  steps: streamSteps('parakeet-tdt', [...HAPPY_EVENTS, ...HAPPY_STATS]),
  finally: destroySession,
  params: {
    audioFileName: AUDIO_FIXTURE,
    chunkMs: 1000,
    emitPartials: true,
    trailingSilenceMs: 1500
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'parakeet',
    dependency: 'parakeet-tdt',
    estimatedDurationMs: 120000
  }
}

/**
 * Unified RNN-T streaming coverage: the `parakeet-unified-en-0.6b`
 * checkpoint serves batch and low-latency streaming from one GGUF, so
 * drive the same happy-path duplex stream against it to lock down the
 * `StreamSession` path on the Unified decoder.
 */
export const parakeetStreamUnifiedHappy: TestDefinition = {
  testId: 'parakeet-stream-unified-happy',
  steps: streamSteps('parakeet-unified', [...HAPPY_EVENTS, ...HAPPY_STATS]),
  finally: destroySession,
  params: {
    audioFileName: AUDIO_FIXTURE,
    chunkMs: 1000,
    emitPartials: true,
    trailingSilenceMs: 1500
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'parakeet',
    dependency: 'parakeet-unified',
    estimatedDurationMs: 120000
  }
}

/**
 * Per-segment metadata over the duplex stream: same paced feed as the happy
 * path, with `metadata: true`, so the session surfaces `segment` events
 * carrying timings and the parakeet-only `isEndOfTurn` / `startsWord` flags.
 */
export const parakeetStreamMetadata: TestDefinition = {
  testId: 'parakeet-stream-metadata',
  params: {
    audioFileName: AUDIO_FIXTURE,
    chunkMs: 1000,
    emitPartials: true,
    trailingSilenceMs: 1500
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'parakeet',
    dependency: 'parakeet-tdt',
    estimatedDurationMs: 120000
  }
}

/**
 * EOU model end-to-end coverage: drives the duplex stream against the
 * `<EOU>`-token-emitting parakeet checkpoint, then asserts that at
 * least one synthetic `endOfTurn` event surfaces alongside transcript
 * text. Locks down the EOU → `isEndOfTurn` → conversation-event path
 * across `ops/transcribe.ts` (`emitSegment`), the parakeet plugin
 * handler, and the client `processLineConversation` decoder.
 */
export const parakeetStreamEou: TestDefinition = {
  testId: 'parakeet-stream-eou',
  steps: streamSteps('parakeet-eou', [
    {
      assert: {
        on: '$events',
        named: 'eventTypeCounts',
        with: { atLeast: { text: 1, endOfTurn: 1 }, absent: ['vad'] }
      }
    },
    // Parakeet's EOU is token-driven, so every boundary it reports must say
    // so and must not carry the silence duration that only the whisper
    // variant of the union has.
    {
      assert: {
        on: '$events',
        named: 'eventShape',
        with: {
          type: 'endOfTurn',
          equals: { source: 'parakeet' },
          absent: ['silenceDurationMs']
        }
      }
    }
  ]),
  finally: destroySession,
  params: {
    audioFileName: EOU_AUDIO_FIXTURE,
    chunkMs: 1000,
    emitPartials: true,
    trailingSilenceMs: 1500
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'parakeet',
    dependency: 'parakeet-eou',
    estimatedDurationMs: 120000
  }
}

/**
 * Mid-utterance teardown: opens a session, writes 2 chunks, calls
 * `session.destroy()`, then opens a fresh session against the same
 * model and runs a happy-path stream. Locks down the parakeet
 * `StreamSession` cleanup contract — `destroy()` must propagate
 * synchronously through the duplex handler so the next session can
 * load against the same modelId without the addon being left in a
 * wedged state.
 */
export const parakeetStreamDestroyMidUtterance: TestDefinition = {
  testId: 'parakeet-stream-destroy-mid-utterance',
  // Two sessions, and the second one is the test. The first is yanked
  // mid-utterance -- a couple of chunks, no `end()` -- and the claim is that
  // the model is still usable afterwards: a native session that left the addon
  // wedged would show up here and nowhere else.
  steps: [
    { useModel: { deps: ['parakeet-tdt'], as: 'model' } },
    { asset: { kind: 'audio', file: '$params.audioFileName', as: 'audio' } },
    {
      call: {
        method: 'transcribeStreamOpen',
        params: {
          modelId: '$model',
          parakeetStreamingConfig: {
            chunkMs: '$params.chunkMs',
            emitPartials: '$params.emitPartials?'
          }
        },
        as: 'first'
      }
    },
    { project: { from: '$first', path: 'sessionId', as: 'sessionId' } },
    {
      call: {
        method: 'transcribeStreamWriteChunks',
        params: {
          sessionId: '$sessionId',
          audio: '$audio',
          chunkMs: '$params.chunkMs',
          chunks: 2
        }
      }
    },
    {
      call: { method: 'transcribeStreamDestroy', params: { sessionId: '$sessionId' }, as: 'torn' }
    },
    { project: { from: '$torn', path: 'destroyed', as: 'destroyed' } },
    { assert: { on: '$destroyed', named: 'isTrue' } },
    {
      call: {
        method: 'transcribeStreamOpen',
        params: {
          modelId: '$model',
          parakeetStreamingConfig: {
            chunkMs: '$params.chunkMs',
            emitPartials: '$params.emitPartials?'
          }
        },
        as: 'second'
      }
    },
    { project: { from: '$second', path: 'sessionId', as: 'secondSessionId' } },
    {
      call: {
        method: 'transcribeStreamWrite',
        params: {
          sessionId: '$secondSessionId',
          audio: '$audio',
          chunkMs: '$params.chunkMs',
          trailingSilenceMs: '$params.trailingSilenceMs?'
        }
      }
    },
    { call: { method: 'transcribeStreamEnd', params: { sessionId: '$secondSessionId' } } },
    {
      call: {
        method: 'transcribeStreamDrain',
        collect: 'events',
        params: { sessionId: '$secondSessionId' },
        as: 'drained'
      }
    },
    { project: { from: '$drained', path: 'events', as: 'events' } },
    ...HAPPY_EVENTS
  ],
  finally: destroySession,
  params: {
    audioFileName: AUDIO_FIXTURE,
    chunkMs: 1000,
    emitPartials: true,
    trailingSilenceMs: 1500
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'parakeet',
    dependency: 'parakeet-tdt',
    estimatedDurationMs: 180000
  }
}

/**
 * Consumer-side iterator throw: the `for await` body throws after
 * the first event surfaces. The iterator MUST unwind (cleanly tear
 * down the native `StreamSession`); a fresh session against the same
 * model must then succeed end-to-end. This is the "consumer
 * disconnect / error path" referenced in PR review #4280580987.
 */
export const parakeetStreamIteratorThrow: TestDefinition = {
  testId: 'parakeet-stream-iterator-throw',
  // The consumer errors out after the first event. `abortAfter` throws into
  // the iterator rather than simply stopping, because the contract is about
  // what happens when the reader goes away in error -- and the proof is that
  // a fresh session against the same model still works.
  steps: [
    { useModel: { deps: ['parakeet-tdt'], as: 'model' } },
    { asset: { kind: 'audio', file: '$params.audioFileName', as: 'audio' } },
    {
      call: {
        method: 'transcribeStreamOpen',
        params: {
          modelId: '$model',
          parakeetStreamingConfig: {
            chunkMs: '$params.chunkMs',
            emitPartials: '$params.emitPartials?'
          }
        },
        as: 'first'
      }
    },
    { project: { from: '$first', path: 'sessionId', as: 'sessionId' } },
    {
      call: {
        method: 'transcribeStreamWrite',
        params: {
          sessionId: '$sessionId',
          audio: '$audio',
          chunkMs: '$params.chunkMs',
          trailingSilenceMs: '$params.trailingSilenceMs?'
        }
      }
    },
    { call: { method: 'transcribeStreamEnd', params: { sessionId: '$sessionId' } } },
    {
      call: {
        method: 'transcribeStreamDrain',
        collect: 'events',
        params: { sessionId: '$sessionId', abortAfter: 1 },
        as: 'aborted'
      }
    },
    { project: { from: '$aborted', path: 'events', as: 'abortedEvents' } },
    { assert: { on: '$abortedEvents', named: 'lengthIs', with: { length: 1 } } },
    { call: { method: 'transcribeStreamDestroy', params: { sessionId: '$sessionId' } } },
    {
      call: {
        method: 'transcribeStreamOpen',
        params: {
          modelId: '$model',
          parakeetStreamingConfig: {
            chunkMs: '$params.chunkMs',
            emitPartials: '$params.emitPartials?'
          }
        },
        as: 'second'
      }
    },
    { project: { from: '$second', path: 'sessionId', as: 'secondSessionId' } },
    {
      call: {
        method: 'transcribeStreamWrite',
        params: {
          sessionId: '$secondSessionId',
          audio: '$audio',
          chunkMs: '$params.chunkMs',
          trailingSilenceMs: '$params.trailingSilenceMs?'
        }
      }
    },
    { call: { method: 'transcribeStreamEnd', params: { sessionId: '$secondSessionId' } } },
    {
      call: {
        method: 'transcribeStreamDrain',
        collect: 'events',
        params: { sessionId: '$secondSessionId' },
        as: 'drained'
      }
    },
    { project: { from: '$drained', path: 'events', as: 'events' } },
    ...HAPPY_EVENTS
  ],
  finally: destroySession,
  params: {
    audioFileName: AUDIO_FIXTURE,
    chunkMs: 1000,
    emitPartials: true,
    trailingSilenceMs: 1500
  },
  expectation: { validation: 'function', fn: () => true },
  metadata: {
    category: 'parakeet',
    dependency: 'parakeet-tdt',
    estimatedDurationMs: 200000
  }
}

export const parakeetStreamTests = [
  parakeetStreamHappy,
  parakeetStreamUnifiedHappy,
  parakeetStreamMetadata,
  parakeetStreamEou,
  parakeetStreamDestroyMidUtterance,
  parakeetStreamIteratorThrow
]

/**
 * `parakeet-stream-metadata` still runs from its imperative body.
 *
 * The blocker is the path language, not the assertions: in metadata mode the
 * segments arrive wrapped one per event, so the body needs `events[*].segment`
 * over a list whose other event types carry no `segment` at all, and today a
 * wildcard walk throws on the first item that lacks the field instead of
 * passing over it. The batch sibling (`parakeet-tdt-metadata`) has no wrapper
 * and is migrated; this one follows once the walk can skip a missing field.
 */
parakeetStreamMetadata.skip = {
  reason:
    'the Python client has no body for this: the segments arrive one per event and the wildcard path cannot yet skip events that carry no segment, so the declarative body is not writable',
  platforms: ['desktop-python']
}
