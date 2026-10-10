import path from 'node:path'
import type { Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from '../abstract-model-executor.js'
import { speakerAwareTests } from '../../../speaker-aware-tests.js'
import { runSpeakerAware } from '../../speaker-aware-runner.js'

export class SpeakerAwareExecutor extends AbstractModelExecutor<typeof speakerAwareTests> {
  pattern = /^speaker-aware-/
  protected handlers = Object.fromEntries(
    speakerAwareTests.map((test) => [
      test.testId,
      async (params: unknown, expectation: unknown) => {
        const modelId = await this.resources.ensureLoaded(test.metadata!.dependency as string)
        return runSpeakerAware(
          modelId,
          path.resolve(process.cwd(), 'assets/audio/diarization-sample-16k.wav'),
          (params as { mode: string }).mode,
          expectation as Expectation
        )
      }
    ])
  ) as never
}
