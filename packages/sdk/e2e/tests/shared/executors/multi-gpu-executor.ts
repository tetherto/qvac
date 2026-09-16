import {
  loadModel,
  unloadModel,
  completion,
  embed,
  LLAMA_3_2_1B_INST_Q4_0,
  EMBEDDINGGEMMA_300M_Q8_0
} from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import type { ResourceManager } from '../resource-manager.js'
import {
  multiGpuConfigSmoke,
  multiGpuTensorConfigSmoke,
  multiGpuEmbedConfigSmoke,
  multiGpuTensorSplitMismatchError,
  multiGpuTests
} from '../../multi-gpu-tests.js'

/**
 * None of the split-mode loads below pins `tensor-split`. The share list is
 * positional — one value per GPU — so any literal encodes the GPU count of the
 * host that wrote it, and the addon rejects a count matching neither the
 * registered GPU count nor the eligible device count. The fleet is mixed
 * (single-GPU macOS and Linux, multi-GPU Windows) and nothing in the SDK
 * reports either count, so no literal is correct everywhere. Omitting it lets
 * qvac-fabric split evenly across whatever the addon pinned, which is what
 * these smoke tests are for: that the split-mode path is accepted end to end
 * and that inference lands on the GPU. The rejection itself is covered
 * separately by multi-gpu-tensor-split-mismatch-error.
 *
 * `main-gpu` is dropped for a second reason: it is ignored outside
 * `split-mode: 'none'`, where it only logs a warning.
 */
export class MultiGpuExecutor extends AbstractModelExecutor<typeof multiGpuTests> {
  pattern = /^multi-gpu-/

  constructor(resources: ResourceManager) {
    super(resources)
  }

  protected handlers = {
    [multiGpuConfigSmoke.testId]: this.llmLayerSplit.bind(this),
    [multiGpuTensorConfigSmoke.testId]: this.llmTensorSplit.bind(this),
    [multiGpuEmbedConfigSmoke.testId]: this.embedLayerSplit.bind(this),
    [multiGpuTensorSplitMismatchError.testId]: this.tensorSplitMismatch.bind(this)
  }

  private async llmLayerSplit(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      history: Array<{ role: string; content: string }>
    }

    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: 'llamacpp-completion',
      modelConfig: {
        ctx_size: 1024,
        verbosity: 0,
        gpu_layers: 99,
        'split-mode': 'layer'
      }
    })

    try {
      const result = completion({ modelId, history: p.history, stream: false })
      const [text, stats] = await Promise.all([result.text, result.stats])
      if (stats?.backendDevice !== 'gpu') {
        return { passed: false, output: `Expected backendDevice=gpu, got ${stats?.backendDevice}` }
      }
      return ValidationHelpers.validate(text, expectation as Expectation)
    } finally {
      await unloadModel({ modelId, clearStorage: false })
    }
  }

  private async llmTensorSplit(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as {
      history: Array<{ role: string; content: string }>
    }

    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: 'llamacpp-completion',
      modelConfig: {
        ctx_size: 1024,
        verbosity: 0,
        gpu_layers: 99,
        'split-mode': 'tensor',
        'flash-attn': 'on'
      }
    })

    try {
      const result = completion({ modelId, history: p.history, stream: false })
      const [text, stats] = await Promise.all([result.text, result.stats])
      if (stats?.backendDevice !== 'gpu') {
        return { passed: false, output: `Expected backendDevice=gpu, got ${stats?.backendDevice}` }
      }
      return ValidationHelpers.validate(text, expectation as Expectation)
    } finally {
      await unloadModel({ modelId, clearStorage: false })
    }
  }

  private async embedLayerSplit(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { text: string }

    const modelId = await loadModel({
      modelSrc: EMBEDDINGGEMMA_300M_Q8_0,
      modelType: 'llamacpp-embedding',
      modelConfig: {
        gpuLayers: 99,
        verbosity: 0,
        splitMode: 'layer'
      }
    })

    try {
      const { embedding, stats } = await embed({ modelId, text: p.text })
      if (stats?.backendDevice !== 'gpu') {
        return { passed: false, output: `Expected backendDevice=gpu, got ${stats?.backendDevice}` }
      }
      return ValidationHelpers.validate(embedding, expectation as Expectation)
    } finally {
      await unloadModel({ modelId, clearStorage: false })
    }
  }

  /**
   * A share count that matches neither device list must fail the load outright.
   * Requires an eligible GPU: with none, the addon drops `tensor-split` and
   * falls back to CPU instead of rejecting — the same assumption the two GPU
   * smoke tests already make by asserting `backendDevice === 'gpu'`.
   */
  private async tensorSplitMismatch(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { tensorSplit: string }

    let modelId: string | undefined
    let loadError: unknown

    try {
      modelId = await loadModel({
        modelSrc: LLAMA_3_2_1B_INST_Q4_0,
        modelType: 'llamacpp-completion',
        modelConfig: {
          ctx_size: 1024,
          verbosity: 0,
          gpu_layers: 99,
          'split-mode': 'layer',
          'tensor-split': p.tensorSplit
        }
      })
    } catch (error) {
      loadError = error
    }

    // Unload before grading, so an accepted load cannot strand the model for
    // the rest of the leg.
    if (modelId !== undefined) {
      await unloadModel({ modelId, clearStorage: false })
      return {
        passed: false,
        output: `Expected the load to be rejected, but tensor-split '${p.tensorSplit}' was accepted`
      }
    }

    const message = loadError instanceof Error ? loadError.message : String(loadError)
    return ValidationHelpers.validate(message, expectation as Expectation)
  }
}
