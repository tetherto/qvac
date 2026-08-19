import { video, type VideoClientParams } from '@qvac/sdk'
import {
  ValidationHelpers,
  type Expectation,
  type ExtractTest,
  type HandlerFn,
  type TestResult
} from '@qvac/qvac-test-suite'
import {
  videoIcLoraContractHappy,
  videoIcLoraContractLowerBoundaries,
  videoIcLoraContractRelativeLoraError,
  videoIcLoraContractTests,
  type VideoIcLoraContractParams
} from '../../video-ic-lora-contract-tests.js'
import { AbstractModelExecutor } from './abstract-model-executor.js'

const expectedMarkerOutputs = [
  new Uint8Array([73, 67, 76, 79, 82, 65]),
  new Uint8Array([86, 73, 68, 69, 79])
]

export class VideoIcLoraContractExecutor extends AbstractModelExecutor<
  typeof videoIcLoraContractTests
> {
  pattern = /^video-ic-lora-contract-/

  protected handlers: Required<{
    [K in (typeof videoIcLoraContractTests)[number]['testId']]: HandlerFn<
      ExtractTest<typeof videoIcLoraContractTests, K>
    >
  }> = {
    [videoIcLoraContractHappy.testId]: this.runSuccess.bind(this),
    [videoIcLoraContractLowerBoundaries.testId]: this.runSuccess.bind(this),
    [videoIcLoraContractRelativeLoraError.testId]: this.runServerValidationError.bind(this)
  }

  private async runSuccess(
    params: VideoIcLoraContractParams,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const modelId = await this.resources.ensureLoaded('echo')
      const outputs = await video(this.buildParams(modelId, params)).outputs
      const mismatch = this.findOutputMismatch(outputs)
      if (mismatch) return { passed: false, output: mismatch }
      const outputText = outputs.map((output) => String.fromCharCode(...output)).join(' ')
      return ValidationHelpers.validate(outputText, expectation)
    } catch (error) {
      return {
        passed: false,
        output: `Video IC-LoRA contract failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  private async runServerValidationError(
    params: VideoIcLoraContractParams,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const modelId = await this.resources.ensureLoaded('echo')
      await video(this.buildParams(modelId, params)).outputs
      return { passed: false, output: 'Expected the server to reject a relative lora path' }
    } catch (error) {
      return ValidationHelpers.validate(error, expectation)
    }
  }

  private buildParams(modelId: string, params: VideoIcLoraContractParams): VideoClientParams {
    const referenceImages: [Uint8Array] = [new Uint8Array(params.reference_images[0])]
    return {
      ...params,
      modelId,
      reference_images: referenceImages
    }
  }

  private findOutputMismatch(outputs: Uint8Array[]): string | null {
    if (outputs.length !== expectedMarkerOutputs.length) {
      return `Expected ${expectedMarkerOutputs.length} video outputs, received ${outputs.length}`
    }
    for (let i = 0; i < expectedMarkerOutputs.length; i++) {
      const actual = outputs[i]!
      const expected = expectedMarkerOutputs[i]!
      if (!this.bytesEqual(actual, expected)) {
        return (
          `Output ${i} bytes differ: expected [${Array.from(expected).join(',')}], ` +
          `received [${Array.from(actual).join(',')}]`
        )
      }
    }
    return null
  }

  private bytesEqual(actual: Uint8Array, expected: Uint8Array) {
    return actual.length === expected.length && actual.every((byte, i) => byte === expected[i])
  }
}
