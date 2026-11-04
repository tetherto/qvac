import { calcTokens } from '@qvac/sdk'
import type { TestResult } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  calcTokensTests,
  type CalcTokensPromptParams
} from '../../../../catalog/calc-tokens-tests.js'

export class CalcTokensExecutor extends AbstractModelExecutor<typeof calcTokensTests> {
  pattern = /^calc-tokens-/
  protected handlers = {
    'calc-tokens-llm-prompt': this.prompt.bind(this)
  }

  async prompt(params: CalcTokensPromptParams): Promise<TestResult> {
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
    return { passed: true, output: `Token counts: short=${shortCount}, long=${longCount}` }
  }
}
