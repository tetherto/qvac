import { invokePlugin, loadModel } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@tetherto/qvac-test-suite'
import { echo, echoStream } from 'custom-echo-plugin/client'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  pluginTests,
  pluginEchoLoadModel,
  pluginEchoInvoke,
  pluginEchoInvokeStream,
  pluginEchoValidationError,
  pluginInvokeUnknownHandler,
  pluginLoadUnknownType
} from '../../plugin-tests.js'

interface EchoInvokeParams {
  message: string
}

interface UnknownTypeParams {
  modelType: string
}

/**
 * Exercises the `custom-echo-plugin` fixture (`fixtures/echo-plugin/`) end-to-end.
 * Happy-path tests go through the plugin's own client wrapper, like a real
 * consumer would; error-path tests call `invokePlugin` directly to send
 * payloads the wrapper doesn't expose (invalid params, unknown handler).
 */
export class PluginExecutor extends AbstractModelExecutor<typeof pluginTests> {
  pattern = /^plugin-/

  protected handlers = {
    [pluginEchoLoadModel.testId]: this.echoLoadModel.bind(this),
    [pluginEchoInvoke.testId]: this.echoInvoke.bind(this),
    [pluginEchoInvokeStream.testId]: this.echoInvokeStream.bind(this),
    [pluginEchoValidationError.testId]: this.echoValidationError.bind(this),
    [pluginInvokeUnknownHandler.testId]: this.invokeUnknownHandler.bind(this),
    [pluginLoadUnknownType.testId]: this.loadUnknownType.bind(this)
  }

  private async ensureEchoModel() {
    return this.resources.ensureLoaded('echo')
  }

  async echoLoadModel(
    _params: Record<string, never>,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const modelId = await this.ensureEchoModel()
      return ValidationHelpers.validate(modelId, expectation)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Failed to load echo model: ${msg}` }
    }
  }

  async echoInvoke(params: EchoInvokeParams, expectation: Expectation): Promise<TestResult> {
    try {
      const modelId = await this.ensureEchoModel()
      const result = await echo(modelId, params.message)
      return ValidationHelpers.validate(result.message, expectation)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Echo invoke failed: ${msg}` }
    }
  }

  async echoInvokeStream(params: EchoInvokeParams, expectation: Expectation): Promise<TestResult> {
    try {
      const modelId = await this.ensureEchoModel()
      const chunks: string[] = []
      for await (const { chunk } of echoStream(modelId, params.message)) {
        chunks.push(chunk)
      }
      return ValidationHelpers.validate(chunks.join(' '), expectation)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Echo stream failed: ${msg}` }
    }
  }

  async echoValidationError(
    _params: Record<string, never>,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const modelId = await this.ensureEchoModel()
      await invokePlugin({
        modelId,
        handler: 'echo',
        params: { notAMessage: 12345 }
      })
      return { passed: false, output: 'Expected validation error but call succeeded' }
    } catch (error) {
      return ValidationHelpers.validate(error, expectation)
    }
  }

  async invokeUnknownHandler(
    _params: EchoInvokeParams,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      const modelId = await this.ensureEchoModel()
      await invokePlugin({
        modelId,
        handler: 'nonExistentHandler',
        params: { message: 'test' }
      })
      return { passed: false, output: 'Expected error for unknown handler but call succeeded' }
    } catch (error) {
      return ValidationHelpers.validate(error, expectation)
    }
  }

  async loadUnknownType(params: UnknownTypeParams, expectation: Expectation): Promise<TestResult> {
    try {
      await loadModel({
        modelSrc: '/nonexistent/path/fake-model.bin',
        modelType: params.modelType
      } as never)
      return { passed: false, output: 'Expected error for unknown model type but call succeeded' }
    } catch (error) {
      return ValidationHelpers.validate(error, expectation)
    }
  }
}
