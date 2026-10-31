import { embedImage, RequestValidationFailedError } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { imageEmbeddingTests } from '../../../../catalog/image-embedding-tests.js'

interface InputParams {
  bytes: number[]
  width?: number
  height?: number
  channels?: 3
}

export class ImageEmbeddingInputExecutor extends AbstractModelExecutor<typeof imageEmbeddingTests> {
  pattern = /^image-embedding-input-/
  protected handlers = Object.fromEntries(
    imageEmbeddingTests.map((test) => [test.testId, this.invalid.bind(this)])
  ) as never

  async invalid(
    { bytes, ...dimensions }: InputParams,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      await embedImage({
        modelId: 'image-input-validation',
        image: Uint8Array.from(bytes),
        ...dimensions
      })
      return { passed: false, output: 'Invalid image embedding input was accepted' }
    } catch (error) {
      if (!(error instanceof RequestValidationFailedError)) {
        return {
          passed: false,
          output: `Expected input validation before worker dispatch, got ${String(error)}`
        }
      }
      return ValidationHelpers.validate(error.message, expectation)
    }
  }
}
