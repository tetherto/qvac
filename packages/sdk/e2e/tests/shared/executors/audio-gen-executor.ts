import {
  audioGen,
  AUDIOGEN_INPUT_CHANNELS,
  AUDIOGEN_INPUT_SAMPLE_RATE,
  type AudioGenClientParams
} from '@qvac/sdk'
import { ValidationHelpers, type Expectation, type TestResult } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import type { ResourceManager } from '../resource-manager.js'
import {
  audioGenCoverMissingSourceError,
  audioGenCoverNofsq,
  audioGenEmptyCaptionError,
  audioGenHappy,
  audioGenReferenceAudio,
  audioGenShortDuration,
  audioGenTests
} from '../../audio-gen-tests.js'

type AudioGenParams = Omit<AudioGenClientParams, 'modelId'>
type ReferenceAudioParams = AudioGenParams & { referenceAudioFileName: string }
type CoverToneParams = AudioGenParams & { sourceTone: { seconds: number; frequency: number } }
const VALIDATION_MUST_PRECEDE_RPC_MODEL_ID = 'must-not-reach-audiogen-model-lookup'

export interface AudioGenExecutorOptions {
  /**
   * Maps a bundled `assets/audio` file name to an absolute path on this
   * platform. Injected as an option rather than through a `resolveParams()`
   * subclass override (the `NodeDiffusionExecutor` pattern) on purpose: only
   * one string field needs resolving, AudioGen e2e is desktop-only today, and
   * `audioGen()` takes file paths directly, so there is no per-platform byte
   * loading to subclass for. Switch to the subclass pattern if a second
   * platform starts running these tests.
   */
  resolveAudioAsset?: (fileName: string) => string
}

export class AudioGenExecutor extends AbstractModelExecutor<typeof audioGenTests> {
  pattern = /^audio-gen-/

  protected handlers = {
    [audioGenHappy.testId]: this.runGeneration.bind(this),
    [audioGenShortDuration.testId]: this.runGeneration.bind(this),
    [audioGenReferenceAudio.testId]: this.runReferenceGeneration.bind(this),
    [audioGenCoverNofsq.testId]: this.runCoverGeneration.bind(this),
    [audioGenEmptyCaptionError.testId]: this.runValidationError.bind(this),
    [audioGenCoverMissingSourceError.testId]: this.runValidationError.bind(this)
  } as never

  constructor(
    resources: ResourceManager,
    private readonly options: AudioGenExecutorOptions = {}
  ) {
    super(resources)
  }

  private async runGeneration(
    params: AudioGenParams,
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('audiogen-turbo')

    try {
      const run = audioGen({ modelId, ...params })
      const progressPromise = collect(run.progressStream)
      const [audio, stats, progress] = await Promise.all([run.audio, run.stats, progressPromise])
      const sampleCount = audio.pcm.byteLength / ((audio.bitsPerSample / 8) * audio.channels)
      const valid =
        sampleCount > 0 &&
        audio.sampleRate > 0 &&
        audio.channels > 0 &&
        audio.bitsPerSample > 0 &&
        progress.length > 0 &&
        stats !== undefined

      if (!valid) {
        return {
          passed: false,
          output:
            `Invalid AudioGen output: samples=${sampleCount}, sampleRate=${audio.sampleRate}, ` +
            `channels=${audio.channels}, progress=${progress.length}, stats=${String(stats !== undefined)}`
        }
      }

      // Report the resolved backend: the same generation costs ~3s on macOS and
      // ~600s on the Ubuntu GPU runner, which no amount of contention explains.
      const backend = `backend=${stats?.backendId ?? '?'}/${stats?.backendDevice ?? '?'}`
      const timing = `rtf=${stats?.realTimeFactor ?? '?'} totalMs=${stats?.totalTimeMs ?? '?'}`
      return ValidationHelpers.validate(
        `generated ${sampleCount} samples at ${audio.sampleRate} Hz with ` +
          `${progress.length} progress ticks and stats [${backend} ${timing}]`,
        expectation
      )
    } catch (error) {
      return {
        passed: false,
        output: `AudioGen failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  private async runReferenceGeneration(
    params: ReferenceAudioParams,
    expectation: Expectation
  ): Promise<TestResult> {
    const { referenceAudioFileName, ...generation } = params
    if (!this.options.resolveAudioAsset) {
      return {
        passed: false,
        output: 'AudioGenExecutor needs resolveAudioAsset to locate bundled reference audio'
      }
    }
    return this.runGeneration(
      { ...generation, referenceAudio: this.options.resolveAudioAsset(referenceAudioFileName) },
      expectation
    )
  }

  private async runCoverGeneration(
    params: CoverToneParams,
    expectation: Expectation
  ): Promise<TestResult> {
    const { sourceTone, ...generation } = params
    return this.runGeneration(
      {
        ...generation,
        sourceAudio: synthesizeStereoTone(sourceTone.seconds, sourceTone.frequency)
      },
      expectation
    )
  }

  private async runValidationError(
    params: AudioGenParams,
    expectation: Expectation
  ): Promise<TestResult> {
    const expectedFragment =
      expectation.validation === 'throws-error' ? expectation.errorContains : 'caption'
    try {
      const run = audioGen({ modelId: VALIDATION_MUST_PRECEDE_RPC_MODEL_ID, ...params })
      await run.audio
      return { passed: false, output: 'Expected AudioGen validation to fail' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        !message.toLowerCase().includes(expectedFragment.toLowerCase()) ||
        message.includes(VALIDATION_MUST_PRECEDE_RPC_MODEL_ID)
      ) {
        return {
          passed: false,
          output: `Expected client ${expectedFragment} validation before model lookup, received: ${message}`
        }
      }
      return ValidationHelpers.validate(message, expectation)
    }
  }
}

/**
 * Raw interleaved stereo 48 kHz Float32 LE PCM: the in-memory form
 * `audioGen()` accepts for `referenceAudio` / `sourceAudio`.
 */
function synthesizeStereoTone(seconds: number, frequency: number) {
  const frames = Math.round(AUDIOGEN_INPUT_SAMPLE_RATE * seconds)
  const pcm = new Float32Array(frames * AUDIOGEN_INPUT_CHANNELS)
  for (let frame = 0; frame < frames; frame++) {
    const sample = 0.1 * Math.sin((2 * Math.PI * frequency * frame) / AUDIOGEN_INPUT_SAMPLE_RATE)
    pcm[frame * AUDIOGEN_INPUT_CHANNELS] = sample
    pcm[frame * AUDIOGEN_INPUT_CHANNELS + 1] = sample
  }
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
}

async function collect<T>(events: AsyncIterable<T>) {
  const collected: T[] = []
  for await (const event of events) collected.push(event)
  return collected
}
