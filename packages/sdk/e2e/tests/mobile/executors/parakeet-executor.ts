import { getModelInfo, PARAKEET_UNIFIED_0_6B_Q4_0, transcribe } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite/mobile'
import type { ResourceManager } from '../../shared/resource-manager.js'
import { ModelAssetExecutor } from './model-asset-executor.js'
import { parakeetTests } from '../../parakeet-tests.js'
import { validateParakeetSegments } from '../../shared/transcription-segments.js'

export class MobileParakeetExecutor extends ModelAssetExecutor<typeof parakeetTests> {
  pattern = /^parakeet-/
  protected handlers = Object.fromEntries(
    parakeetTests.map((test) => [
      test.testId,
      (params: unknown, expectation: unknown) => this.runTest(test.testId, params, expectation)
    ])
  ) as never
  protected defaultHandler = undefined

  private audioAssets: Record<string, number> | null = null

  constructor(resources: ResourceManager) {
    super(resources)
  }

  private async loadAudioAssets() {
    if (!this.audioAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import('../../../../assets')
      this.audioAssets = assets.audio
    }
    return this.audioAssets!
  }

  async runTest(testId: string, params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { audioFileName: string; metadata?: boolean }
    const exp = expectation as Expectation

    if (testId === 'parakeet-unified-coreml-ios') {
      const info = await getModelInfo({ name: PARAKEET_UNIFIED_0_6B_Q4_0.name })
      if (!info.registryPath?.includes('/2026-09-30/')) {
        return { passed: false, output: `Expected the regenerated GGUF, got ${info.registryPath}` }
      }
    }

    const resourceKey = this.resolveResource(testId)
    const modelId = await this.resources.ensureLoaded(resourceKey)

    if (testId === 'parakeet-unified-coreml-ios') {
      const info = await getModelInfo({ name: PARAKEET_UNIFIED_0_6B_Q4_0.name })
      const suffixes = [
        'analytics/coremldata.bin',
        'coremldata.bin',
        'metadata.json',
        'model.mil',
        'weights/weight.bin'
      ]
      const bundleRoot = 'parakeet-unified-en-0.6b-encoder.mlmodelc/'
      const missing = suffixes.filter(
        (suffix) =>
          !info.cacheFiles.some((file) => file.isCached && file.path.includes(bundleRoot + suffix))
      )
      if (!info.isCached || missing.length > 0) {
        return {
          passed: false,
          output: `Core ML bundle incomplete in iOS cache: ${missing.join(', ') || 'model not cached'}`
        }
      }
    }

    const audio = await this.loadAudioAssets()
    const assetModule = audio[p.audioFileName]
    if (!assetModule) {
      return { passed: false, output: `Audio file not found: ${p.audioFileName}` }
    }

    try {
      const audioUri = await this.resolveAsset(assetModule)

      if (p.metadata === true) {
        const segments = await transcribe({ modelId, audioChunk: audioUri, metadata: true })
        return validateParakeetSegments(segments)
      }

      const operation = transcribe({ modelId, audioChunk: audioUri })
      const text = await operation
      const trimmedText = text.trim()

      if (testId === 'parakeet-unified-coreml-ios') {
        const stats = await operation.stats
        if (stats?.encoderOnCoreml !== 1 || stats.encoderUsedCoreml !== 1) {
          return {
            passed: false,
            output: `Expected Core ML encoder use during batch transcription, got ${JSON.stringify(stats)}`
          }
        }
      }

      if (exp.validation === 'throws-error') {
        return { passed: false, output: 'Expected error but transcription succeeded' }
      }
      return ValidationHelpers.validate(trimmedText, exp)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (exp.validation === 'throws-error') {
        return ValidationHelpers.validate(errorMsg, exp)
      }
      return { passed: false, output: `Parakeet transcription failed: ${errorMsg}` }
    }
  }

  private resolveResource(testId: string): string {
    if (testId.startsWith('parakeet-indic-conformer-')) return 'parakeet-indic-conformer'
    if (testId.startsWith('parakeet-ctc-')) return 'parakeet-ctc'
    if (testId.startsWith('parakeet-unified-')) return 'parakeet-unified'
    if (testId.startsWith('parakeet-sortformer-')) return 'parakeet-sortformer'
    return 'parakeet-tdt'
  }
}
