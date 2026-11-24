import { completion } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite/mobile'
import type { ResourceManager } from '../../shared/resource-manager.js'
import { ModelAssetExecutor } from './model-asset-executor.js'
import { visionTests } from '../../../../catalog/vision-tests.js'
import { callWhenAddonIdle } from '../../shared/utils/addon-idle.js'

type ContentPart = { type: 'text'; text: string } | { type: 'media'; path: string }

type VisionParams = {
  history: Array<{ role: string; content: string | ContentPart[] }>
  stream?: boolean
  generationParams?: Record<string, unknown>
}

export class MobileVisionExecutor extends ModelAssetExecutor<typeof visionTests> {
  pattern = /^vision-/

  protected handlers = Object.fromEntries(
    visionTests.map((test) => {
      if (test.testId === 'vision-image-no-upscale') {
        return [test.testId, this.imageNoUpscale.bind(this)]
      }
      if (test.testId.endsWith('-streaming')) {
        return [test.testId, this.streaming.bind(this)]
      }
      if (test.testId.endsWith('-stats')) {
        return [test.testId, this.withStats.bind(this)]
      }
      return [test.testId, this.generic.bind(this)]
    })
  ) as never
  protected defaultHandler = undefined

  private imageAssets: Record<string, number> | null = null

  constructor(resources: ResourceManager) {
    super(resources)
  }

  private async getPromptTokens(modelId: string, params: VisionParams) {
    const history = await this.resolveMedia(params.history)
    return callWhenAddonIdle(async () => {
      const result = completion({
        modelId,
        history,
        stream: false,
        ...(params.generationParams && { generationParams: params.generationParams })
      } as never)
      await result.text
      const stats = await result.stats
      if (typeof stats?.promptTokens !== 'number' || stats.promptTokens <= 0) {
        throw new Error(`Completion stats missing promptTokens. Got: ${JSON.stringify(stats)}`)
      }
      return stats.promptTokens
    })
  }

  async imageNoUpscale(params: unknown, _expectation: Expectation): Promise<TestResult> {
    const p = params as VisionParams

    try {
      const noUpscaleModelId = await this.resources.ensureLoaded('vision')
      const noUpscaleTokens = await this.getPromptTokens(noUpscaleModelId, p)

      await this.resources.evict('vision')

      const upscaleModelId = await this.resources.ensureLoaded('vision-upscale')
      const upscaleTokens = await this.getPromptTokens(upscaleModelId, p)

      if (noUpscaleTokens * 2 >= upscaleTokens) {
        return {
          passed: false,
          output:
            `image_no_upscale on (${noUpscaleTokens}) should use less than half the prompt tokens ` +
            `of off (${upscaleTokens})`
        }
      }

      return {
        passed: true,
        output: `image_no_upscale reduced prompt tokens from ${upscaleTokens} to ${noUpscaleTokens}`
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `image_no_upscale comparison failed: ${errorMsg}` }
    }
  }

  private async loadImageAssets() {
    if (!this.imageAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import('../../../../../assets')
      this.imageAssets = assets.images
    }
    return this.imageAssets!
  }

  private async resolveMedia(history: VisionParams['history']) {
    const images = await this.loadImageAssets()
    const resolved = []

    for (const msg of history) {
      if (typeof msg.content === 'string') {
        resolved.push(msg)
        continue
      }

      const content: ContentPart[] = []
      for (const part of msg.content) {
        if (part.type !== 'media') {
          content.push(part)
          continue
        }
        const fileName = part.path.split('/').pop()!
        const assetModule = images[fileName]
        if (!assetModule) {
          throw new Error(`Image file not found in assets: ${fileName}`)
        }
        content.push({ ...part, path: await this.resolveAsset(assetModule) })
      }

      resolved.push({ ...msg, content })
    }

    return resolved
  }

  async generic(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as VisionParams
    const visionModelId = await this.resources.ensureLoaded('vision')

    try {
      const history = await this.resolveMedia(p.history)
      const text = await callWhenAddonIdle(
        () =>
          completion({
            modelId: visionModelId,
            history,
            stream: false,
            ...(p.generationParams && { generationParams: p.generationParams })
          } as never).text
      )
      return ValidationHelpers.validate(text, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (expectation.validation === 'throws-error') {
        return ValidationHelpers.validate(errorMsg, expectation)
      }
      return { passed: false, output: `Vision failed: ${errorMsg}` }
    }
  }

  async streaming(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as VisionParams
    const visionModelId = await this.resources.ensureLoaded('vision')

    try {
      const history = await this.resolveMedia(p.history)
      const tokens = await callWhenAddonIdle(async () => {
        const result = completion({
          modelId: visionModelId,
          history,
          stream: true,
          ...(p.generationParams && { generationParams: p.generationParams })
        } as never)
        const acc: string[] = []
        for await (const token of result.tokenStream) {
          acc.push(token)
        }
        return acc
      })

      if (tokens.length === 0) {
        return { passed: false, output: 'Streaming produced zero tokens' }
      }

      const text = tokens.join('')
      const validation = ValidationHelpers.validate(text, expectation)
      return {
        ...validation,
        output: `${validation.output} (streamed ${tokens.length} tokens)`
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Vision streaming failed: ${errorMsg}` }
    }
  }

  async withStats(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as VisionParams
    const visionModelId = await this.resources.ensureLoaded('vision')

    try {
      const history = await this.resolveMedia(p.history)
      const { text, stats } = await callWhenAddonIdle(async () => {
        const result = completion({
          modelId: visionModelId,
          history,
          stream: false,
          ...(p.generationParams && { generationParams: p.generationParams })
        } as never)
        return { text: await result.text, stats: await result.stats }
      })

      const textValidation = ValidationHelpers.validate(text, expectation)
      if (!textValidation.passed) return textValidation

      if (!stats) {
        return { passed: false, output: `Vision OK but stats were undefined. Text: "${text}"` }
      }
      if (typeof stats.timeToFirstToken !== 'number' || typeof stats.tokensPerSecond !== 'number') {
        return { passed: false, output: `Stats missing fields. Got: ${JSON.stringify(stats)}` }
      }

      return {
        passed: true,
        output: `Text: "${text}", ttft: ${stats.timeToFirstToken}ms, tps: ${stats.tokensPerSecond}`
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Vision stats failed: ${errorMsg}` }
    }
  }
}
