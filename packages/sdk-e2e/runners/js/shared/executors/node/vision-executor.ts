import { completion } from '@qvac/sdk'
import * as path from 'node:path'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from '../abstract-model-executor.js'
import { visionTests } from '../../../../../catalog/vision-tests.js'
import { callWhenAddonIdle } from '../../utils/addon-idle.js'

type ContentPart = { type: 'text'; text: string } | { type: 'media'; path: string }

type VisionParams = {
  history: Array<{ role: string; content: string | ContentPart[] }>
  stream?: boolean
  generationParams?: Record<string, unknown>
}

export class VisionExecutor extends AbstractModelExecutor<typeof visionTests> {
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

  private async getPromptTokens(modelId: string, params: VisionParams) {
    const history = this.resolveMedia(params.history)
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
            `imageNoUpscale on (${noUpscaleTokens}) should use less than half the prompt tokens ` +
            `of off (${upscaleTokens})`
        }
      }

      return {
        passed: true,
        output: `imageNoUpscale reduced prompt tokens from ${upscaleTokens} to ${noUpscaleTokens}`
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `imageNoUpscale comparison failed: ${errorMsg}` }
    }
  }

  private resolveMedia(history: VisionParams['history']) {
    return history.map((msg) => {
      if (typeof msg.content === 'string') return msg
      return {
        ...msg,
        content: msg.content.map((part) => {
          if (part.type !== 'media') return part
          const fileName = part.path.split('/').pop()!
          return { ...part, path: path.resolve(process.cwd(), 'assets/images', fileName) }
        })
      }
    })
  }

  async generic(params: unknown, expectation: Expectation): Promise<TestResult> {
    const p = params as VisionParams
    const visionModelId = await this.resources.ensureLoaded('vision')
    const history = this.resolveMedia(p.history)

    try {
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
    const history = this.resolveMedia(p.history)

    try {
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
    const history = this.resolveMedia(p.history)

    try {
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
