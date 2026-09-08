import { loadModel, embed, completion, GTE_LARGE_FP16 } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { shardedModelTests } from '../../sharded-model-tests.js'

interface ShardedCompletionParams {
  history: ReadonlyArray<{ role: string; content: string }>
  generationParams?: Record<string, unknown>
}

type CompletionFnParams = Parameters<typeof completion>[0]

export class ShardedModelExecutor extends AbstractModelExecutor<typeof shardedModelTests> {
  pattern = /^sharded-model-/

  protected handlers = Object.fromEntries(
    shardedModelTests.map((test) => {
      if (test.testId === 'sharded-model-backward-compatibility') {
        return [test.testId, this.backwardCompatibility.bind(this)]
      }
      if (test.testId === 'sharded-model-batch-inference') {
        return [test.testId, this.batchInference.bind(this)]
      }
      if (
        test.testId === 'sharded-model-inference' ||
        test.testId === 'sharded-model-long-text-inference'
      ) {
        return [test.testId, this.inference.bind(this)]
      }
      if (test.testId === 'sharded-model-llm-load') {
        return [test.testId, this.loadShardedLlm.bind(this)]
      }
      if (test.testId === 'sharded-model-llm-completion') {
        return [test.testId, this.llmCompletion.bind(this)]
      }
      if (test.testId === 'sharded-model-llm-reload') {
        return [test.testId, this.llmReload.bind(this)]
      }
      if (test.testId === 'sharded-model-llm-missing-shards') {
        return [test.testId, this.llmMissingShards.bind(this)]
      }
      return [test.testId, this.loadSharded.bind(this)]
    })
  ) as never

  async loadSharded(params: unknown, expectation: unknown): Promise<TestResult> {
    const shardedModelId = await this.resources.ensureLoaded('sharded-embeddings')
    return ValidationHelpers.validate(shardedModelId, expectation as Expectation)
  }

  async backwardCompatibility(params: unknown, expectation: unknown): Promise<TestResult> {
    try {
      const modelId = await loadModel({
        modelSrc: GTE_LARGE_FP16,
        modelType: 'llamacpp-embedding'
      })
      await this.resources.register('embeddings', modelId)
      return ValidationHelpers.validate(modelId, expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Backward compatibility failed: ${errorMsg}` }
    }
  }

  async inference(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string }
    const modelId = await this.resources.ensureLoaded('sharded-embeddings')

    try {
      const { embedding: embeddings } = await embed({ modelId, text: p.text })
      return ValidationHelpers.validate(embeddings, expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Sharded inference failed: ${errorMsg}` }
    }
  }

  async batchInference(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { texts: string[] }
    const modelId = await this.resources.ensureLoaded('sharded-embeddings')

    try {
      const embeddings = []
      for (const text of p.texts) {
        const { embedding } = await embed({ modelId, text })
        embeddings.push(embedding)
      }
      return ValidationHelpers.validate(embeddings, expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Sharded batch inference failed: ${errorMsg}` }
    }
  }

  private async runShardedCompletion(params: ShardedCompletionParams): Promise<string> {
    const modelId = await this.resources.ensureLoaded('sharded-llm')
    const result = completion({
      modelId,
      ...params,
      stream: false
    } as CompletionFnParams)
    return result.text
  }

  async loadShardedLlm(params: unknown, expectation: unknown): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded('sharded-llm')
    return ValidationHelpers.validate(modelId, expectation as Expectation)
  }

  async llmCompletion(params: unknown, expectation: unknown): Promise<TestResult> {
    try {
      const text = await this.runShardedCompletion(params as ShardedCompletionParams)
      return ValidationHelpers.validate(text, expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Sharded LLM completion failed: ${errorMsg}` }
    }
  }

  async llmReload(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as ShardedCompletionParams

    try {
      const first = await this.runShardedCompletion(p)
      await this.resources.evict('sharded-llm')
      const second = await this.runShardedCompletion(p)

      const firstResult = ValidationHelpers.validate(first, expectation as Expectation)
      if (!firstResult.passed) {
        return { passed: false, output: `Before reload: ${firstResult.output}` }
      }
      const secondResult = ValidationHelpers.validate(second, expectation as Expectation)
      if (!secondResult.passed) {
        return { passed: false, output: `After reload: ${secondResult.output}` }
      }

      return {
        passed: true,
        output: `Sharded LLM survived reload — before: "${first.trim()}", after: "${second.trim()}"`
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Sharded LLM reload failed: ${errorMsg}` }
    }
  }

  async llmMissingShards(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { modelPath: string }

    try {
      await loadModel({
        modelSrc: p.modelPath,
        modelType: 'llamacpp-completion'
      })
      return {
        passed: false,
        output: `Expected loadModel to throw for missing shards at ${p.modelPath}`
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : JSON.stringify(error)
      return ValidationHelpers.validate(errorMsg, expectation as Expectation)
    }
  }
}
