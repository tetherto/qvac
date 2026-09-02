import { ragIngest } from '@qvac/sdk'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from '../abstract-model-executor.js'
import { getRagWorkspaceName, runTurboVecRag, type RagParams } from '../../rag-turbovec-runner.js'
import { ragTests } from '../../../rag-tests.js'

function getQvacDataDir() {
  return path.join(process.env['SNAP_USER_COMMON'] || os.homedir(), '.qvac')
}

function prepareTurboVecWorkspace(workspace: string) {
  const workspaceDir = path.join(getQvacDataDir(), 'rag-hyperdb', workspace)
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.writeFileSync(
    path.join(workspaceDir, '.qvac-rag-workspace.json'),
    `${JSON.stringify({ version: 1, adapterType: 'turbovec' })}\n`
  )
}

function hasTurboVecCheckpoint(workspace: string) {
  const checkpointDir = path.join(getQvacDataDir(), 'rag-turbovec', workspace)
  if (!fs.existsSync(checkpointDir)) return false
  return fs.readdirSync(checkpointDir, { withFileTypes: true }).some((entry) => {
    return (
      entry.isDirectory() &&
      entry.name.startsWith('database-') &&
      fs.existsSync(path.join(checkpointDir, entry.name, 'manifest.json'))
    )
  })
}

export class RagExecutor extends AbstractModelExecutor<typeof ragTests> {
  pattern = /^rag-/

  protected handlers = Object.fromEntries(
    ragTests.map((test) => [test.testId, this.generic.bind(this)])
  ) as never

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as RagParams
    const exp = expectation as Expectation
    const embeddingModelId = await this.resources.ensureLoaded('embeddings')

    try {
      let content: string
      if (p.documentFile) {
        const docPath = path.resolve(process.cwd(), 'assets/documents', p.documentFile)
        content = fs.readFileSync(docPath, 'utf-8')
      } else {
        content = p.documentContent || ''
      }

      const uniqueWorkspace = getRagWorkspaceName(p, embeddingModelId)

      if (p.adapter === 'turbovec') {
        return await this.turboVec(p, exp, content, embeddingModelId, uniqueWorkspace)
      }

      const result = await ragIngest({
        modelId: embeddingModelId,
        workspace: uniqueWorkspace,
        documents: [content] as never,
        chunk: true,
        chunkOpts: {
          chunkSize: p.chunkSize,
          chunkOverlap: p.chunkOverlap,
          ...(p.chunkStrategy
            ? { chunkStrategy: p.chunkStrategy as 'paragraph' | 'character' }
            : {})
        }
      })

      if (exp.validation === 'throws-error') {
        return { passed: false, output: 'Expected error but RAG succeeded' }
      }
      const resultStr = result.processed.length > 0 ? 'success' : 'failed'
      return ValidationHelpers.validate(resultStr, exp)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (exp.validation === 'throws-error') {
        return ValidationHelpers.validate(errorMsg, exp)
      }
      return { passed: false, output: `RAG failed: ${errorMsg}` }
    }
  }

  private async turboVec(
    params: RagParams,
    expectation: Expectation,
    content: string,
    embeddingModelId: string,
    workspace: string
  ): Promise<TestResult> {
    try {
      const output = await runTurboVecRag({
        params,
        content,
        embeddingModelId,
        workspace,
        prepareWorkspace: prepareTurboVecWorkspace,
        hasCheckpoint: hasTurboVecCheckpoint
      })
      return ValidationHelpers.validate(output, expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `TurboVec RAG failed: ${errorMsg}` }
    }
  }
}
