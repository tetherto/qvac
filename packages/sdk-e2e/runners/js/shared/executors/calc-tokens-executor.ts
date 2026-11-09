import { calcTokens, completion, RequestValidationFailedError } from '@qvac/sdk'
import { ValidationHelpers, type Expectation, type TestResult } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  calcTokensTests,
  type CalcTokensInvalidParams,
  type CalcTokensParityParams,
  type CalcTokensPromptParams,
  type CalcTokensToolsParams
} from '../../../../catalog/calc-tokens-tests.js'

export class CalcTokensExecutor extends AbstractModelExecutor<typeof calcTokensTests> {
  pattern = /^calc-tokens-/
  protected handlers = {
    'calc-tokens-llm-prompt': this.prompt.bind(this),
    'calc-tokens-rejects-missing-prompt': this.invalid.bind(this),
    'calc-tokens-rejects-unknown-key': this.invalid.bind(this),
    'calc-tokens-rejects-non-llm': this.nonLlm.bind(this),
    'calc-tokens-counts-tools': this.tools.bind(this),
    'calc-tokens-matches-completion': this.matchesCompletion.bind(this)
  }

  async prompt(params: CalcTokensPromptParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')
    const shortCount = await calcTokens({ modelId, text: params.shortText })
    const longCount = await calcTokens({
      modelId,
      history: [{ role: 'system', content: 'You are concise.' }],
      text: params.longText
    })

    if (shortCount <= 0) {
      return { passed: false, output: `Expected a positive token count, got ${shortCount}` }
    }
    if (longCount <= shortCount) {
      return {
        passed: false,
        output: `Expected the longer prompt to exceed ${shortCount} tokens, got ${longCount}`
      }
    }
    const validation = ValidationHelpers.validate(shortCount, expectation)
    return validation.passed
      ? { passed: true, output: `Token counts: short=${shortCount}, long=${longCount}` }
      : validation
  }

  async invalid(params: CalcTokensInvalidParams, expectation: Expectation): Promise<TestResult> {
    try {
      await calcTokens(params.request as never)
      return { passed: false, output: 'Invalid calcTokens input was accepted' }
    } catch (error) {
      if (!(error instanceof RequestValidationFailedError)) {
        return { passed: false, output: `Expected a validation error, got ${String(error)}` }
      }
      return ValidationHelpers.validate(error.message, expectation)
    }
  }

  async nonLlm(_params: unknown, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('embeddings')
    try {
      await calcTokens({ modelId, text: 'Hello' })
      return { passed: false, output: 'calcTokens accepted a non-LLM model' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return ValidationHelpers.validate(message, expectation)
    }
  }

  async tools(params: CalcTokensToolsParams, expectation: Expectation): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('tools')
    const plainCount = await calcTokens({ modelId, text: params.text })
    const toolCount = await calcTokens({ modelId, text: params.text, tools: [params.tool] })
    if (toolCount <= plainCount) {
      return {
        passed: false,
        output: `Expected tools to increase ${plainCount} tokens, got ${toolCount}`
      }
    }
    return ValidationHelpers.validate(toolCount, expectation)
  }

  async matchesCompletion(
    params: CalcTokensParityParams,
    expectation: Expectation
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('llm')
    const count = await calcTokens({ modelId, history: params.history })
    const run = completion({
      modelId,
      history: params.history,
      stream: false,
      generationParams: { predict: 1 }
    })
    await run.text
    const promptTokens = (await run.stats)?.promptTokens
    if (count !== promptTokens) {
      return {
        passed: false,
        output: `calcTokens=${count}, completion promptTokens=${String(promptTokens)}`
      }
    }
    return ValidationHelpers.validate(count, expectation)
  }
}
