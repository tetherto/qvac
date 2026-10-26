import {
  completion,
  loadModel,
  unloadModel,
  QWEN3_5_0_8B_MTP_Q4_K_M,
  QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
  type CompletionStats
} from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  speculativeDecodingDraftNMaxOutOfRangeRejected,
  speculativeDecodingMtp,
  speculativeDecodingMtpExternalHead,
  speculativeDecodingNone,
  speculativeDecodingTests
} from '../../../../catalog/speculative-decoding-tests.js'

type CompletesParams = { prompt: string }
type Source = typeof QWEN3_5_0_8B_MTP_Q4_K_M | typeof QWEN3_5_0_8B_MULTIMODAL_Q4_K_M

/** The executor body of the step-defined tests, for consumers without the step interpreter. */
export class SpeculativeDecodingExecutor extends AbstractModelExecutor<
  typeof speculativeDecodingTests
> {
  pattern = /^speculative-decoding-/

  protected handlers = {
    [speculativeDecodingMtp.testId]: this.mtp.bind(this),
    [speculativeDecodingMtpExternalHead.testId]: this.mtpExternalHead.bind(this),
    [speculativeDecodingNone.testId]: this.none.bind(this),
    [speculativeDecodingDraftNMaxOutOfRangeRejected.testId]: this.rejectDraftNMax.bind(this)
  } as never

  async mtp(params: unknown, expectation: unknown): Promise<TestResult> {
    return this.drafts(
      await this.completesWith(params as CompletesParams, expectation, 'draft-mtp')
    )
  }

  // The base model has no MTP layers; the MTP model's head drafts for it.
  async mtpExternalHead(params: unknown, expectation: unknown): Promise<TestResult> {
    return this.drafts(
      await this.completesWith(params as CompletesParams, expectation, 'draft-mtp', {
        modelSrc: QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
        draftModelSrc: QWEN3_5_0_8B_MTP_Q4_K_M
      })
    )
  }

  private drafts({ result, stats }: { result: TestResult; stats: CompletionStats | undefined }) {
    if (!result.passed) return result
    const drafted = stats?.draftTokens
    const accepted = stats?.draftAcceptedTokens
    if (drafted === undefined || drafted < 1 || accepted === undefined || accepted > drafted) {
      return {
        passed: false,
        output: `expected 1+ drafted >= accepted, got ${JSON.stringify(stats)}`
      }
    }
    return result
  }

  async none(params: unknown, expectation: unknown): Promise<TestResult> {
    const { result, stats } = await this.completesWith(
      params as CompletesParams,
      expectation,
      'none'
    )
    if (!result.passed) return result
    if (stats?.draftTokens !== undefined || stats?.draftAcceptedTokens !== undefined) {
      return { passed: false, output: `expected no draft counters, got ${JSON.stringify(stats)}` }
    }
    return result
  }

  async rejectDraftNMax(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { draftNMax: number }
    try {
      const modelId = await loadModel({
        modelSrc: QWEN3_5_0_8B_MTP_Q4_K_M,
        modelType: 'llamacpp-completion',
        modelConfig: { spec_type: 'draft-mtp', spec_draft_n_max: p.draftNMax }
      })
      await unloadModel({ modelId })
      return { passed: false, output: 'spec_draft_n_max above 64 should have been rejected' }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : JSON.stringify(error)
      // The addon's own range error means the value skipped SDK validation.
      if (/must be an integer between/.test(errorMsg)) {
        return { passed: false, output: `spec_draft_n_max reached the addon: ${errorMsg}` }
      }
      return ValidationHelpers.validate(errorMsg, expectation as Expectation)
    }
  }

  private async completesWith(
    p: CompletesParams,
    expectation: unknown,
    specType: string,
    {
      modelSrc = QWEN3_5_0_8B_MTP_Q4_K_M,
      draftModelSrc
    }: { modelSrc?: Source; draftModelSrc?: Source } = {}
  ) {
    const modelId = await loadModel({
      modelSrc,
      modelType: 'llamacpp-completion',
      modelConfig: {
        ctx_size: 2048,
        spec_type: specType as 'draft-mtp' | 'none',
        ...(draftModelSrc ? { draftModelSrc } : {})
      }
    })
    try {
      const final = await completion({
        modelId,
        history: [{ role: 'user', content: p.prompt }],
        stream: false,
        generationParams: { temp: 0, seed: 42, predict: 96, reasoning_budget: 0 }
      }).final
      const stats: CompletionStats | undefined = final.stats
      return {
        result: ValidationHelpers.validate(final.contentText, expectation as Expectation),
        stats
      }
    } finally {
      await unloadModel({ modelId })
    }
  }
}
