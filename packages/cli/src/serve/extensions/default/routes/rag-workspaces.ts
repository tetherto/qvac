import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  ragChunk,
  ragCloseWorkspace,
  ragDeleteWorkspace,
  ragIngest,
  ragListWorkspaces,
  ragReindex
} from '@qvac/sdk'
import type { QvacContext } from '@/serve/core/context'
import { requireModel } from '@/serve/core/plugins/require-model'
import { errorResponses } from '@/serve/lib/error-responses'
import { HttpError } from '@/serve/lib/http-error'
import {
  chunkBody,
  chunkResult,
  ingestBody,
  ingestResult,
  reindexResult,
  workspaceClosed,
  workspaceDeleted,
  workspaceList,
  workspaceParams
} from '@/serve/extensions/default/schemas/rag'

const descriptions = {
  chunk: `
Split documents into chunks without embedding or storing them, backed by the
SDK's \`ragChunk()\`. Use it to tune \`chunkOpts\` before ingesting, or to chunk
text you embed and store yourself.
`.trim(),
  ingest: `
Chunk, embed and store documents in a workspace, backed by the SDK's
\`ragIngest()\`. Creates the workspace on first use and leaves it open.

Unlike \`POST /v1/vector_stores/{id}/files\`, this takes the text inline, picks
the embedding model by alias, and exposes the chunking options. A workspace
holds one embedding model: ingesting with another alias than the one that built
it is refused with \`embedding_model_mismatch\`.

Search the workspace with \`POST /v1/vector_stores/{id}/search\`. That route
embeds the query with the default embedding model, so ingest with the same
alias.
`.trim(),
  reindex: `
Rebalance a workspace's search index, backed by the SDK's \`ragReindex()\`.
Worth running after large ingests. Needs a minimum number of stored chunks (16
by default); with fewer, \`reindexed\` is \`false\` and \`details\` says why.
`.trim(),
  list: 'Every workspace on disk, and whether it is loaded in memory.',
  close:
    'Release a workspace from memory. Its data stays on disk and the next ingest or search reopens it.',
  remove: 'Close a workspace if it is open, then delete it and all its data.'
}

const WORKSPACE_404 = { 404: { workspace_not_found: 'No workspace by that name exists' } }

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  const ctx = app.qvac
  const embeddingByWorkspace = new Map<string, string>()
  const serialize = createKeyedQueue()

  app.post(
    '/qvac/v1/rag/chunk',
    {
      schema: {
        body: chunkBody,
        response: {
          200: chunkResult,
          ...errorResponses({
            400: {
              invalid_json: 'Body is not valid JSON',
              invalid_documents: '`documents` is missing, empty, or not text',
              invalid_chunk_opts: '`chunkOpts` carries an unknown field or an invalid value',
              invalid_request: 'The body carries an unknown field'
            },
            500: { rag_chunk_failed: 'The SDK failed to chunk the documents' }
          })
        },
        tags: ['RAG'],
        summary: 'Chunk documents',
        description: descriptions.chunk
      }
    },
    async (req) => {
      const { documents, chunkOpts } = req.body
      ctx.logger.info(`  rag chunk documents=${countDocuments(documents)}`)
      const chunks = await sdkCall(ctx, 'rag_chunk_failed', 'Failed to chunk documents.', () =>
        ragChunk({ documents, ...(chunkOpts !== undefined && { chunkOpts }) })
      )
      return { object: 'list' as const, data: chunks }
    }
  )

  app.post(
    '/qvac/v1/rag/workspaces/:workspace/ingest',
    {
      schema: {
        params: workspaceParams,
        body: ingestBody,
        response: {
          200: ingestResult,
          ...errorResponses({
            400: {
              invalid_json: 'Body is not valid JSON',
              invalid_workspace: 'The workspace name is not `[a-zA-Z0-9_-]{1,64}`',
              missing_model: '`model` is missing',
              invalid_model_type: '`model` is not an embedding alias',
              invalid_documents: '`documents` is missing, empty, or not text',
              invalid_chunk: '`chunk` is not a boolean',
              invalid_chunk_opts: '`chunkOpts` carries an unknown field or an invalid value',
              embedding_model_mismatch: 'The workspace was built with another embedding alias',
              invalid_request: 'The body carries an unknown field'
            },
            404: { model_not_found: '`model` names no `serve.models` alias' },
            500: { rag_ingest_failed: 'The SDK failed to ingest the documents' },
            503: {
              model_not_loaded: 'The model is not loaded and lazy loading is off',
              model_load_failed: 'The model failed to load',
              model_load_timeout: 'The model did not load in time'
            }
          })
        },
        tags: ['RAG'],
        summary: 'Ingest documents into a workspace',
        description: descriptions.ingest
      },
      preHandler: requireModel('embedding')
    },
    async (req) => {
      const { workspace } = req.params
      const { documents, chunk, chunkOpts } = req.body
      const { alias, sdkModelId } = req.qvacModel!

      return await serialize(workspace, async () => {
        // The workspace may have been deleted through /v1/vector_stores, which
        // does not know this map; a record for a missing workspace is stale.
        if (!(await listWorkspaces(ctx)).some((w) => w.name === workspace)) {
          embeddingByWorkspace.delete(workspace)
        }
        const recorded = embeddingByWorkspace.get(workspace)
        if (recorded !== undefined && recorded !== alias) {
          throw new HttpError(
            400,
            'embedding_model_mismatch',
            `Workspace "${workspace}" was built with embedding "${recorded}", not "${alias}". Ingest with "${recorded}" or use another workspace.`
          )
        }

        ctx.logger.info(
          `  rag ingest workspace=${workspace} model=${alias} documents=${countDocuments(documents)}`
        )
        const result = await sdkCall(
          ctx,
          'rag_ingest_failed',
          'Failed to ingest documents into the workspace.',
          () =>
            ragIngest({
              modelId: sdkModelId,
              documents,
              workspace,
              ...(chunk !== undefined && { chunk }),
              ...(chunkOpts !== undefined && { chunkOpts })
            })
        )
        embeddingByWorkspace.set(workspace, alias)
        return { object: 'rag.ingest' as const, workspace, model: alias, ...result }
      })
    }
  )

  app.post(
    '/qvac/v1/rag/workspaces/:workspace/reindex',
    {
      schema: {
        params: workspaceParams,
        response: {
          200: reindexResult,
          ...errorResponses({
            400: { invalid_workspace: 'The workspace name is not `[a-zA-Z0-9_-]{1,64}`' },
            ...WORKSPACE_404,
            500: { rag_reindex_failed: 'The SDK failed to reindex the workspace' }
          })
        },
        tags: ['RAG'],
        summary: 'Reindex a workspace',
        description: descriptions.reindex
      }
    },
    async (req) => {
      const { workspace } = req.params
      return await serialize(workspace, async () => {
        await findWorkspace(ctx, workspace)
        ctx.logger.info(`  rag reindex workspace=${workspace}`)
        const result = await sdkCall(
          ctx,
          'rag_reindex_failed',
          'Failed to reindex the workspace.',
          () => ragReindex({ workspace })
        )
        return { object: 'rag.reindex' as const, workspace, ...result }
      })
    }
  )

  app.get(
    '/qvac/v1/rag/workspaces',
    {
      schema: {
        response: {
          200: workspaceList,
          ...errorResponses({
            500: { rag_list_workspaces_failed: 'The SDK failed to list workspaces' }
          })
        },
        tags: ['RAG'],
        summary: 'List workspaces',
        description: descriptions.list
      }
    },
    async () => {
      const workspaces = await listWorkspaces(ctx)
      return {
        object: 'list' as const,
        data: workspaces.map((w) => ({ object: 'rag.workspace' as const, ...w }))
      }
    }
  )

  app.post(
    '/qvac/v1/rag/workspaces/:workspace/close',
    {
      schema: {
        params: workspaceParams,
        response: {
          200: workspaceClosed,
          ...errorResponses({
            400: { invalid_workspace: 'The workspace name is not `[a-zA-Z0-9_-]{1,64}`' },
            ...WORKSPACE_404,
            500: { rag_close_workspace_failed: 'The SDK failed to close the workspace' }
          })
        },
        tags: ['RAG'],
        summary: 'Close a workspace',
        description: descriptions.close
      }
    },
    async (req) => {
      const { workspace } = req.params
      return await serialize(workspace, async () => {
        const found = await findWorkspace(ctx, workspace)
        if (found.open) {
          ctx.logger.info(`  rag close workspace=${workspace}`)
          await sdkCall(ctx, 'rag_close_workspace_failed', 'Failed to close the workspace.', () =>
            ragCloseWorkspace({ workspace })
          )
        }
        return { object: 'rag.workspace' as const, name: workspace, open: false as const }
      })
    }
  )

  app.delete(
    '/qvac/v1/rag/workspaces/:workspace',
    {
      schema: {
        params: workspaceParams,
        response: {
          200: workspaceDeleted,
          ...errorResponses({
            400: { invalid_workspace: 'The workspace name is not `[a-zA-Z0-9_-]{1,64}`' },
            ...WORKSPACE_404,
            500: { rag_delete_workspace_failed: 'The SDK failed to delete the workspace' }
          })
        },
        tags: ['RAG'],
        summary: 'Delete a workspace',
        description: descriptions.remove
      }
    },
    async (req) => {
      const { workspace } = req.params
      return await serialize(workspace, async () => {
        const found = await findWorkspace(ctx, workspace)
        ctx.logger.info(`  rag delete workspace=${workspace}`)
        await sdkCall(ctx, 'rag_delete_workspace_failed', 'Failed to delete the workspace.', () =>
          found.open
            ? ragCloseWorkspace({ workspace, deleteOnClose: true })
            : ragDeleteWorkspace({ workspace })
        )
        embeddingByWorkspace.delete(workspace)
        return { object: 'rag.workspace.deleted' as const, name: workspace, deleted: true as const }
      })
    }
  )
}

function countDocuments(documents: string | string[]): number {
  return Array.isArray(documents) ? documents.length : 1
}

async function sdkCall<T>(
  ctx: QvacContext,
  code: string,
  message: string,
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof HttpError) throw err
    const detail = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`  ${code}: ${detail}`)
    throw new HttpError(500, code, message)
  }
}

async function listWorkspaces(ctx: QvacContext): Promise<Array<{ name: string; open: boolean }>> {
  return await sdkCall(ctx, 'rag_list_workspaces_failed', 'Failed to list workspaces.', () =>
    ragListWorkspaces()
  )
}

async function findWorkspace(
  ctx: QvacContext,
  workspace: string
): Promise<{ name: string; open: boolean }> {
  const found = (await listWorkspaces(ctx)).find((w) => w.name === workspace)
  if (!found) {
    throw new HttpError(404, 'workspace_not_found', `Workspace "${workspace}" not found.`)
  }
  return found
}

// Runs calls for one key one at a time, so a close or delete never lands in the
// middle of an ingest on the same workspace.
export function createKeyedQueue(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return function <T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve()
    const next = previous.then(run, run)
    const tail = next.catch(() => undefined)
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return next
  }
}

export default plugin
