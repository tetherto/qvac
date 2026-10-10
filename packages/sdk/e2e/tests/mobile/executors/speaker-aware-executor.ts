import type { Expectation } from '@qvac/test-suite'
import { ModelAssetExecutor } from './model-asset-executor.js'
import { speakerAwareTests } from '../../speaker-aware-tests.js'
import { runSpeakerAware } from '../../shared/speaker-aware-runner.js'

export class MobileSpeakerAwareExecutor extends ModelAssetExecutor<typeof speakerAwareTests> {
  pattern = /^speaker-aware-/
  protected handlers = Object.fromEntries(
    speakerAwareTests.map((test) => [
      test.testId,
      async (params: unknown, expectation: unknown) => {
        // @ts-ignore - assets.ts is generated at consumer build time
        const assets = await import('../../../../assets')
        const audioPath = await this.resolveAsset(assets.audio['diarization-sample-16k.wav'])
        const modelId = await this.resources.ensureLoaded(test.metadata!.dependency as string)
        return runSpeakerAware(
          modelId,
          audioPath,
          (params as { mode: string }).mode,
          expectation as Expectation
        )
      }
    ])
  ) as never
}
