import { ragIngest } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite/mobile'
import type { ResourceManager } from '../../shared/resource-manager.js'
import {
  describeErrorChain,
  getRagWorkspaceName,
  runTurboVecRag,
  type RagParams,
  type TurboVecCheckpointProbe
} from '../../shared/rag-turbovec-runner.js'
import { ModelAssetExecutor } from './model-asset-executor.js'
import { ragTests } from '../../rag-tests.js'

async function prepareTurboVecWorkspace(workspace: string) {
  // @ts-ignore - expo-file-system is a peer dependency available in mobile context
  const { Directory, File, Paths } = await import('expo-file-system')
  const workspaceDir = new Directory(Paths.document, '.qvac', 'rag-hyperdb', workspace)
  workspaceDir.create({ intermediates: true, idempotent: true })
  const marker = new File(workspaceDir, '.qvac-rag-workspace.json')
  marker.create({ intermediates: true, overwrite: true })
  marker.write(`${JSON.stringify({ version: 1, adapterType: 'turbovec' })}\n`)
}

// Mobile sets no cacheDirectory, so the engine's RAG roots sit under
// Paths.document/.qvac. Add one and this must follow it, as the node probe does.
async function inspectTurboVecCheckpoint(workspace: string): Promise<TurboVecCheckpointProbe> {
  // @ts-ignore - expo-file-system is a peer dependency available in mobile context
  const { Directory, File, Paths } = await import('expo-file-system')
  const checkpointDir = new Directory(Paths.document, '.qvac', 'rag-turbovec', workspace)
  if (!checkpointDir.exists) return { state: 'no-root', root: checkpointDir.uri }
  const hasManifest = checkpointDir.list().some((entry) => {
    return entry instanceof Directory && new File(entry, 'manifest.json').exists
  })
  return hasManifest ? { state: 'present' } : { state: 'no-manifest', root: checkpointDir.uri }
}

export class MobileRagExecutor extends ModelAssetExecutor<typeof ragTests> {
  pattern = /^rag-/

  protected handlers = Object.fromEntries(
    ragTests.map((test) => [test.testId, this.generic.bind(this)])
  ) as never
  protected defaultHandler = undefined

  private documentAssets: Record<string, number> | null = null

  constructor(resources: ResourceManager) {
    super(resources)
  }

  private async loadDocumentAssets() {
    if (!this.documentAssets) {
      // @ts-ignore - assets.ts is generated at consumer build time
      const assets = await import('../../../../assets')
      this.documentAssets = assets.documents
    }
    return this.documentAssets!
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as RagParams
    const exp = expectation as Expectation
    const embeddingModelId = await this.resources.ensureLoaded('embeddings')

    try {
      let content: string
      if (p.documentFile) {
        const documents = await this.loadDocumentAssets()
        const assetModule = documents[p.documentFile]
        if (!assetModule) {
          return { passed: false, output: `Document file not found: ${p.documentFile}` }
        }
        const docUri = await this.resolveAsset(assetModule)
        // @ts-ignore - expo-file-system is a peer dependency available in mobile context
        const { File } = await import('expo-file-system')
        content = await new File(`file://${docUri}`).text()
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
        inspectCheckpoint: inspectTurboVecCheckpoint
      })
      return ValidationHelpers.validate(output, expectation)
    } catch (error) {
      return { passed: false, output: `TurboVec RAG failed: ${describeErrorChain(error)}` }
    }
  }
}
