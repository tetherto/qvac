import { audioGen, type AudioGenClientParams } from '@qvac/sdk'
import { ValidationHelpers, type Expectation, type TestResult } from '@tetherto/qvac-test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  audioGenEmptyCaptionError,
  audioGenHappy,
  audioGenShortDuration,
  audioGenTests
} from '../../audio-gen-tests.js'

type AudioGenParams = Omit<AudioGenClientParams, 'modelId'>
const VALIDATION_MUST_PRECEDE_RPC_MODEL_ID = 'must-not-reach-audiogen-model-lookup'

export class AudioGenExecutor extends AbstractModelExecutor<typeof audioGenTests> {
  pattern = /^audio-gen-/

  protected handlers = {
    [audioGenHappy.testId]: this.runGeneration.bind(this),
    [audioGenShortDuration.testId]: this.runGeneration.bind(this),
    [audioGenEmptyCaptionError.testId]: this.runValidationError.bind(this)
  } as never

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

      return ValidationHelpers.validate(
        `generated ${sampleCount} samples at ${audio.sampleRate} Hz with ` +
          `${progress.length} progress ticks and stats`,
        expectation
      )
    } catch (error) {
      return {
        passed: false,
        output: `AudioGen failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  private async runValidationError(
    params: AudioGenParams,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const run = audioGen({ modelId: VALIDATION_MUST_PRECEDE_RPC_MODEL_ID, ...params })
      await run.audio
      return { passed: false, output: 'Expected AudioGen validation to fail' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        !message.toLowerCase().includes('caption') ||
        message.includes(VALIDATION_MUST_PRECEDE_RPC_MODEL_ID)
      ) {
        return {
          passed: false,
          output: `Expected client caption validation before model lookup, received: ${message}`
        }
      }
      return ValidationHelpers.validate(message, expectation)
    }
  }
}

async function collect<T>(events: AsyncIterable<T>) {
  const collected: T[] = []
  for await (const event of events) collected.push(event)
  return collected
}
