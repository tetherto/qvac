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
  multiGpuTensorSplitAppliedSmoke,
  multiGpuTensorSplitMismatchError,
  multiGpuTests
} from '../../multi-gpu-tests.js'

type ChatHistory = Array<{ role: string; content: string }>

/** The two device counts a `tensor-split` share list may be written against. */
type SplitDeviceCounts = { registered: number; eligible: number }

/**
 * Reads both device counts out of the addon's rejection. Tolerates the singular
 * so a host with one of either still parses.
 */
function parseSplitDeviceCounts(message: string): SplitDeviceCounts | undefined {
  const match = /(\d+) registered GPU devices? nor the (\d+) eligible devices?/.exec(message)
  if (!match) return undefined
  return { registered: Number(match[1]), eligible: Number(match[2]) }
}

/** An all-equal share list of the given length, e.g. 3 -> '1,1,1'. */
function evenShares(count: number) {
  return new Array(count).fill('1').join(',')
}

/**
 * `tensor-split` is positional — one share per GPU — so a literal share list
 * encodes the GPU count of the host that wrote it, and the addon rejects a
 * count matching neither the registered GPU count nor the eligible device
 * count. The fleet is mixed (single-GPU macOS and Linux, multi-GPU Windows),
 * so no literal is valid everywhere.
 *
 * There is also no API that reports either count: they are the addon's own,
 * taken from the ggml registry and from the list it pins after applying the
 * backend allowlist, deduplication and RPC hoisting. The SDK's GPU inventory
 * (`getSystemResources`) comes from a separate OS-level collector and is not
 * guaranteed to agree with either, so it cannot stand in for them.
 *
 * These tests therefore ask the addon, via a load it is guaranteed to reject,
 * whose message names both counts — see `probeRejection`. The smoke loads that
 * only need *a* GPU split omit `tensor-split` entirely and let qvac-fabric
 * spread evenly over whatever was pinned.
 *
 * `main-gpu` is dropped throughout for a second reason: it is ignored outside
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
    [multiGpuTensorSplitAppliedSmoke.testId]: this.tensorSplitApplied.bind(this),
    [multiGpuTensorSplitMismatchError.testId]: this.tensorSplitMismatch.bind(this)
  }

  /**
   * One `split-mode: 'layer'` load plus a completion, asserting the work landed
   * on the GPU. `tensorSplit` is omitted for the plain split-mode smoke and
   * supplied by the tests that exercise a share list.
   */
  private async completeWithLayerSplit(
    history: ChatHistory,
    expectation: Expectation,
    tensorSplit?: string
  ): Promise<TestResult> {
    const modelId = await loadModel({
      modelSrc: LLAMA_3_2_1B_INST_Q4_0,
      modelType: 'llamacpp-completion',
      modelConfig: {
        ctx_size: 1024,
        verbosity: 0,
        gpu_layers: 99,
        'split-mode': 'layer',
        ...(tensorSplit === undefined ? {} : { 'tensor-split': tensorSplit })
      }
    })

    try {
      const result = completion({ modelId, history, stream: false })
      const [text, stats] = await Promise.all([result.text, result.stats])
      if (stats?.backendDevice !== 'gpu') {
        return { passed: false, output: `Expected backendDevice=gpu, got ${stats?.backendDevice}` }
      }
      return ValidationHelpers.validate(text, expectation)
    } finally {
      await unloadModel({ modelId, clearStorage: false })
    }
  }

  /**
   * Loads with a share count nothing can match and returns the rejection
   * message, or undefined when the load was accepted after all — in which case
   * the model is unloaded again so it cannot strand the rest of the leg.
   *
   * Requires an eligible GPU: with none, the addon drops `tensor-split` and
   * falls back to CPU instead of rejecting. That is the same assumption the GPU
   * smoke tests already make by asserting `backendDevice === 'gpu'`.
   */
  private async probeRejection(tensorSplit: string): Promise<string | undefined> {
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
          'tensor-split': tensorSplit
        }
      })
    } catch (error) {
      loadError = error
    }

    if (modelId !== undefined) {
      await unloadModel({ modelId, clearStorage: false })
      return undefined
    }

    return loadError instanceof Error ? loadError.message : String(loadError)
  }

  private async llmLayerSplit(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { history: ChatHistory }
    return this.completeWithLayerSplit(p.history, expectation as Expectation)
  }

  private async llmTensorSplit(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { history: ChatHistory }

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
   * A correctly sized `tensor-split` must be accepted and still run on the GPU.
   * Both accepted cardinalities are covered where the host offers both: a list
   * per eligible device is applied in the pinned order, while a list per
   * registered GPU goes through the remap that the pinned device list made
   * necessary. They collapse to one load on a host where every registered GPU
   * is eligible.
   *
   * Shares are all-equal. Uneven shares would not buy anything, because no SDK
   * surface reports per-device layer placement, so the test could not tell a
   * correct remap from a wrong one either way — and they risk an unbalanced
   * split OOMing on an asymmetric host.
   */
  private async tensorSplitApplied(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { history: ChatHistory; probeTensorSplit: string }

    const rejection = await this.probeRejection(p.probeTensorSplit)
    if (rejection === undefined) {
      return {
        passed: false,
        output: `Probe tensor-split '${p.probeTensorSplit}' was accepted, so the device counts could not be read`
      }
    }

    const counts = parseSplitDeviceCounts(rejection)
    if (counts === undefined) {
      return {
        passed: false,
        output: `Could not read the device counts from the rejection: ${rejection}`
      }
    }

    const cardinalities =
      counts.registered === counts.eligible
        ? [counts.eligible]
        : [counts.eligible, counts.registered]

    const outputs: string[] = []
    for (const count of cardinalities) {
      const shares = evenShares(count)
      const result = await this.completeWithLayerSplit(
        p.history,
        expectation as Expectation,
        shares
      )
      if (!result.passed) {
        return { passed: false, output: `tensor-split '${shares}': ${result.output}` }
      }
      outputs.push(`tensor-split '${shares}' accepted: ${result.output}`)
    }

    return { passed: true, output: outputs.join(' | ') }
  }

  /**
   * A share count that matches neither device list must fail the load outright,
   * rather than being zero-padded or truncated — both silently leave a
   * participating GPU without its share.
   */
  private async tensorSplitMismatch(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { tensorSplit: string }

    const rejection = await this.probeRejection(p.tensorSplit)
    if (rejection === undefined) {
      return {
        passed: false,
        output: `Expected the load to be rejected, but tensor-split '${p.tensorSplit}' was accepted`
      }
    }

    return ValidationHelpers.validate(rejection, expectation as Expectation)
  }
}
