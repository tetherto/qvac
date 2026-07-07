import { batchCompletion } from '@qvac/sdk'
import { ValidationHelpers, type Expectation, type TestResult } from '@tetherto/qvac-test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { batchCompletionTests } from '../../batch-completion-tests.js'
import type { ResourceManager } from '../resource-manager.js'

interface BatchCompletionTestParams {
  prompts: Parameters<typeof batchCompletion>[0]['prompts']
  stream?: boolean
  resourceKey?: string
  toolDialect?: Parameters<typeof batchCompletion>[0]['toolDialect']
  expectedById?: Record<string, string[]>
  expectedAnyById?: Record<string, string[]>
  expectedToolCall?: {
    id: string
    name: string
    argKeys?: string[]
    noToolCallIds?: string[]
  }
}

type BatchAttachmentResolver = (path: string) => string | Promise<string>

interface BatchCompletionExecutorOptions {
  resolveAttachmentPath?: BatchAttachmentResolver
}

export class BatchCompletionExecutor extends AbstractModelExecutor<typeof batchCompletionTests> {
  pattern = /^batch-completion-/

  constructor(
    resources: ResourceManager,
    private options: BatchCompletionExecutorOptions = {}
  ) {
    super(resources)
  }

  protected handlers = Object.fromEntries(
    batchCompletionTests.map((test) => [test.testId, this.generic.bind(this)])
  ) as never

  async generic(params: BatchCompletionTestParams, expectation: Expectation): Promise<TestResult> {
    try {
      const llmModelId = await this.resources.ensureLoaded(params.resourceKey ?? 'llm-batch')
      const prompts = await this.resolvePromptAttachments(params.prompts)
      const run = batchCompletion({
        modelId: llmModelId,
        prompts,
        stream: params.stream ?? false,
        ...(params.toolDialect && { toolDialect: params.toolDialect })
      })

      const streamedContentCounts: Record<string, number> = {}
      if (params.stream) {
        for await (const { id, event } of run.events) {
          if (event.type === 'contentDelta' && event.text.length > 0) {
            streamedContentCounts[id] = (streamedContentCounts[id] ?? 0) + 1
          }
        }
      }

      const ids = await run.ids
      const results = await run.results
      if (ids.length !== prompts.length) {
        return {
          passed: false,
          output: `Expected ${prompts.length} ids, got ${ids.length}`
        }
      }
      if (params.stream) {
        const missingStreamedContent = ids.filter((id) => (streamedContentCounts[id] ?? 0) === 0)
        if (missingStreamedContent.length > 0) {
          return {
            passed: false,
            output: `Missing streamed content for ids: ${missingStreamedContent.join(', ')}`
          }
        }

        const byIdResults = await Promise.all(
          ids.map(async (id) => ({
            id,
            final: await run.byId(id).final
          }))
        )
        const mismatched = results.filter((result, index) => {
          const byIdResult = byIdResults[index]
          return (
            byIdResult === undefined ||
            byIdResult.id !== result.id ||
            byIdResult.final.contentText !== result.final.contentText
          )
        })
        if (mismatched.length > 0) {
          return {
            passed: false,
            output: `byId finals diverged for ids: ${mismatched
              .map((result) => result.id)
              .join(', ')}`
          }
        }
      }

      if (params.expectedToolCall) {
        return await this.validateToolCall(run, results, params.expectedToolCall)
      }

      if (params.expectedById) {
        return this.validateExpectedById(results, params.expectedById, params.expectedAnyById)
      }

      if (params.expectedAnyById) {
        return this.validateExpectedById(results, undefined, params.expectedAnyById)
      }

      const output = results.map((result) => `${result.id}:${result.final.contentText}`).join('\n')
      return ValidationHelpers.validate(output, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (expectation.validation === 'throws-error') {
        return ValidationHelpers.validate(errorMsg, expectation)
      }
      return { passed: false, output: `batchCompletion failed: ${errorMsg}` }
    }
  }

  private async resolvePromptAttachments(prompts: BatchCompletionTestParams['prompts']) {
    const resolveAttachmentPath = this.options.resolveAttachmentPath
    if (!resolveAttachmentPath) return prompts

    const resolved: BatchCompletionTestParams['prompts'] = []
    for (const prompt of prompts) {
      const history: typeof prompt.history = []
      for (const message of prompt.history) {
        if (!message.attachments?.length) {
          history.push(message)
          continue
        }
        const attachments: NonNullable<typeof message.attachments> = []
        for (const attachment of message.attachments) {
          attachments.push({
            path: await resolveAttachmentPath(attachment.path)
          })
        }
        history.push({ ...message, attachments })
      }
      resolved.push({ ...prompt, history })
    }
    return resolved
  }

  private async validateToolCall(
    run: ReturnType<typeof batchCompletion>,
    results: Awaited<ReturnType<typeof batchCompletion>['results']>,
    expected: NonNullable<BatchCompletionTestParams['expectedToolCall']>
  ): Promise<TestResult> {
    const targetResult = results.find((result) => result.id === expected.id)
    if (!targetResult) {
      return {
        passed: false,
        output: `Expected result id ${expected.id}, got: ${results
          .map((result) => result.id)
          .join(', ')}`
      }
    }

    const byIdFinal = await run.byId(expected.id).final
    if (byIdFinal.toolCalls.length !== targetResult.final.toolCalls.length) {
      return {
        passed: false,
        output: `byId(${expected.id}) tool calls diverged from aggregate result`
      }
    }

    const match = targetResult.final.toolCalls.find((call) => call.name === expected.name)
    if (!match) {
      return {
        passed: false,
        output: `Expected tool call ${expected.name}, got: ${targetResult.final.toolCalls
          .map((call) => call.name)
          .join(', ')}`
      }
    }

    for (const key of expected.argKeys ?? []) {
      if (!(key in match.arguments)) {
        return {
          passed: false,
          output: `Tool call ${expected.name} missing argument ${key}. Got: ${JSON.stringify(match.arguments)}`
        }
      }
    }

    for (const id of expected.noToolCallIds ?? []) {
      const final = await run.byId(id).final
      if (final.toolCalls.length > 0) {
        return {
          passed: false,
          output: `Expected no tool calls for ${id}, got: ${final.toolCalls
            .map((call) => call.name)
            .join(', ')}`
        }
      }
    }

    return {
      passed: true,
      output: `Tool call ${expected.name} routed to ${expected.id}`
    }
  }

  private validateExpectedById(
    results: Awaited<ReturnType<typeof batchCompletion>['results']>,
    expectedById: Record<string, string[]> | undefined,
    expectedAnyById: Record<string, string[]> | undefined
  ): TestResult {
    const resultsById = new Map(results.map((result) => [result.id, result.final.contentText]))
    const missing: string[] = []

    for (const [id, expectedStrings] of Object.entries(expectedById ?? {})) {
      const text = resultsById.get(id)
      if (text === undefined) {
        missing.push(`${id}:<missing result>`)
        continue
      }

      for (const expected of expectedStrings) {
        if (!text.includes(expected)) {
          missing.push(`${id}:${expected}`)
        }
      }
    }

    for (const [id, expectedStrings] of Object.entries(expectedAnyById ?? {})) {
      const text = resultsById.get(id)
      if (text === undefined) {
        missing.push(`${id}:<missing result>`)
        continue
      }

      if (!expectedStrings.some((expected) => text.includes(expected))) {
        missing.push(`${id}:one of [${expectedStrings.join(', ')}]`)
      }
    }

    if (missing.length > 0) {
      const output = results.map((result) => `${result.id}:${result.final.contentText}`).join('\n')
      return {
        passed: false,
        output: `Missing per-id strings: ${missing.join(', ')}. Got: ${output}`
      }
    }

    return {
      passed: true,
      output: results.map((result) => `${result.id}:${result.final.contentText}`).join('\n')
    }
  }
}
