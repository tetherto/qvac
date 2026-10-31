import { batchCompletion, completion, embed, loadModel, unloadModel } from '@qvac/sdk'
import { ValidationHelpers, type Expectation, type TestResult } from '@qvac/test-suite'
import { backendNameTests } from '../../../../catalog/backend-name-tests.js'
import { AbstractModelExecutor } from './abstract-model-executor.js'

interface BackendNameParams {
  operation: 'completion' | 'embed' | 'batch' | 'invalid'
  resourceKey: string
  stream?: boolean
}

const history = [{ role: 'user', content: 'Reply with only the word APPLE.' }]
const generationParams = { temp: 0, top_k: 1, seed: 42, predict: 16 }

function requireBackend(stats: { backendName?: string; backendDevice?: string } | undefined): void {
  const name = stats?.backendName
  if (!name) {
    throw new Error(`Missing or unexpected backendName: ${JSON.stringify(stats)}`)
  }
  const families = name.split(',')
  if (
    families.some(
      (family) => !['cpu', 'cuda', 'metal', 'vulkan', 'opencl', 'rpc'].includes(family)
    ) ||
    families.join(',') !== [...new Set(families)].sort().join(',')
  ) {
    throw new Error(`Expected canonical, distinct, sorted backend families, got ${name}`)
  }
  if (stats?.backendDevice !== (name === 'cpu' ? 'cpu' : 'gpu')) {
    throw new Error(`backendDevice disagrees with backendName: ${JSON.stringify(stats)}`)
  }
}

function requireApple(text: string): void {
  if (!text.toUpperCase().includes('APPLE')) {
    throw new Error(`Expected APPLE in completion, got ${JSON.stringify(text)}`)
  }
}

export class BackendNameExecutor extends AbstractModelExecutor<typeof backendNameTests> {
  pattern = /^backend-name-/

  protected handlers = Object.fromEntries(
    backendNameTests.map((test) => [test.testId, this.run.bind(this)])
  ) as never

  async run(params: BackendNameParams, expectation: Expectation): Promise<TestResult> {
    try {
      if (params.operation === 'invalid') return await this.invalidPriority(expectation)
      const modelId = await this.resources.ensureLoaded(params.resourceKey)

      if (params.operation === 'embed') {
        const result = await embed({ modelId, text: 'A red apple grows on a tree.' })
        requireBackend(result.stats)
        const vector = result.embedding as number[]
        const norm = Math.hypot(...vector)
        if (vector.length === 0 || !Number.isFinite(norm) || norm < 0.01 || norm > 100) {
          throw new Error(`Expected a finite nonzero embedding, got norm ${norm}`)
        }
        return ValidationHelpers.validate(result.stats?.backendName, expectation)
      }

      if (params.operation === 'batch') {
        const run = batchCompletion({
          modelId,
          stream: params.stream ?? false,
          prompts: [
            { id: 'first', history, generationParams },
            { id: 'second', history, generationParams }
          ]
        })
        const streamed = new Set<string>()
        for await (const { id, event } of run.events) {
          if (event.type === 'contentDelta' && event.text.length > 0) streamed.add(id)
        }
        const results = await run.results
        if (results.length !== 2 || streamed.size !== 2) {
          throw new Error(
            `Expected two batch results and streams, got ${results.length}/${streamed.size}`
          )
        }
        for (const result of results) requireApple(result.final.contentText)
        const stats = await run.stats
        requireBackend(stats)
        return ValidationHelpers.validate(stats?.backendName, expectation)
      }

      const run = completion({ modelId, history, generationParams, stream: params.stream ?? false })
      let statsEvents = 0
      let eventBackendName: string | undefined
      let streamedText = ''
      for await (const event of run.events) {
        if (event.type === 'completionStats') {
          requireBackend(event.stats)
          if (eventBackendName !== undefined && eventBackendName !== event.stats.backendName) {
            throw new Error('Completion stats events disagree on backendName')
          }
          eventBackendName = event.stats.backendName
          statsEvents++
        }
        if (event.type === 'contentDelta') streamedText += event.text
      }
      const final = await run.final
      requireApple(final.contentText)
      requireBackend(final.stats)
      const stats = await run.stats
      requireBackend(stats)
      if (
        eventBackendName !== final.stats?.backendName ||
        stats?.backendName !== eventBackendName
      ) {
        throw new Error(
          'Completion event, final response, and stats promise disagree on backendName'
        )
      }
      if (statsEvents === 0 || (params.stream && streamedText !== final.contentText)) {
        throw new Error(
          'Completion stats event or streamed content did not match the final response'
        )
      }
      return ValidationHelpers.validate(stats?.backendName, expectation)
    } catch (error) {
      return { passed: false, output: error instanceof Error ? error.message : String(error) }
    }
  }

  private async invalidPriority(expectation: Expectation): Promise<TestResult> {
    let modelId: string | undefined
    try {
      const source = await this.resources.loadParams('llm')
      modelId = await loadModel({
        ...source,
        modelConfig: { backend: ['not-a-backend'] }
      } as never)
      return { passed: false, output: 'Invalid backend priority unexpectedly loaded a model' }
    } catch (error) {
      const record = error as { code?: string | number; message?: string }
      return ValidationHelpers.validate(
        `${record.code ?? ''} ${record.message ?? String(error)}`,
        expectation
      )
    } finally {
      if (modelId !== undefined) await unloadModel({ modelId })
    }
  }
}
