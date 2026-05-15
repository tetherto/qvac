import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError } from '../../http.js'
import type { APIAdapter, RouteContext } from '../types.js'

export function createOpenAIAdapter (): APIAdapter {
  return {
    name: 'openai',
    prefix: '/v1',

    async route (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
      const url = req.url ?? ''
      const method = req.method ?? ''
      const path = url.split('?')[0] ?? ''

      if (!path.startsWith('/v1')) return false

      if (method === 'GET' && path === '/v1/models') {
        const { handleListModels } = await import('./routes/models.js')
        handleListModels(req, res, ctx)
        return true
      }

      if (method === 'GET' && path.startsWith('/v1/models/')) {
        const { handleGetModel } = await import('./routes/models.js')
        handleGetModel(req, res, ctx)
        return true
      }

      if (method === 'DELETE' && path.startsWith('/v1/models/')) {
        const { handleDeleteModel } = await import('./routes/models.js')
        await handleDeleteModel(req, res, ctx)
        return true
      }

      if (method === 'POST' && path === '/v1/responses') {
        const { handlePostResponses } = await import('./routes/responses.js')
        await handlePostResponses(req, res, ctx)
        return true
      }

      if (path.startsWith('/v1/responses/')) {
        const { routeResponsesId } = await import('./routes/responses-id.js')
        const handled = await routeResponsesId(req, res, ctx)
        if (handled) return true
      }

      if (method === 'POST' && path === '/v1/chat/completions') {
        const { handleChatCompletions } = await import('./routes/chat.js')
        await handleChatCompletions(req, res, ctx)
        return true
      }

      if (method === 'POST' && path === '/v1/completions') {
        const { handleCompletions } = await import('./routes/completions.js')
        await handleCompletions(req, res, ctx)
        return true
      }

      if (method === 'POST' && path === '/v1/embeddings') {
        const { handleEmbeddings } = await import('./routes/embeddings.js')
        await handleEmbeddings(req, res, ctx)
        return true
      }

      if (method === 'POST' && path === '/v1/audio/transcriptions') {
        const { handleTranscriptions } = await import('./routes/transcriptions.js')
        await handleTranscriptions(req, res, ctx)
        return true
      }

      if (method === 'POST' && path === '/v1/audio/translations') {
        const { handleTranslations } = await import('./routes/translations.js')
        await handleTranslations(req, res, ctx)
        return true
      }

      if (method === 'POST' && path === '/v1/images/generations') {
        const { handleImagesGenerations } = await import('./routes/images.js')
        await handleImagesGenerations(req, res, ctx)
        return true
      }

      if (method === 'POST' && path === '/v1/images/edits') {
        const { handleImagesEdits } = await import('./routes/images.js')
        await handleImagesEdits(req, res, ctx)
        return true
      }

      if (method === 'POST' && path === '/v1/files') {
        const { handlePostFile } = await import('./routes/files.js')
        await handlePostFile(req, res, ctx)
        return true
      }

      if (method === 'GET' && path === '/v1/files') {
        const { handleListFiles } = await import('./routes/files.js')
        handleListFiles(req, res, ctx)
        return true
      }

      const fileContentMatch = path.match(/^\/v1\/files\/([^/]+)\/content$/)
      if (fileContentMatch && method === 'GET') {
        const { handleGetFileContent } = await import('./routes/files.js')
        handleGetFileContent(req, res, ctx, fileContentMatch[1] ?? '')
        return true
      }

      const fileIdMatch = path.match(/^\/v1\/files\/([^/]+)$/)
      if (fileIdMatch && method === 'GET') {
        const { handleGetFile } = await import('./routes/files.js')
        handleGetFile(req, res, ctx, fileIdMatch[1] ?? '')
        return true
      }

      if (method === 'GET' && path === '/v1/vector_stores') {
        const { handleListVectorStores } = await import('./routes/vector-stores.js')
        await handleListVectorStores(req, res, ctx)
        return true
      }

      if (method === 'POST' && path === '/v1/vector_stores') {
        const { handleCreateVectorStore } = await import('./routes/vector-stores.js')
        await handleCreateVectorStore(req, res, ctx)
        return true
      }

      const vectorStoreSub = path.match(/^\/v1\/vector_stores\/([^/]+)\/(search|files)$/)
      if (vectorStoreSub) {
        const id = vectorStoreSub[1] ?? ''
        const sub = vectorStoreSub[2]
        if (sub === 'search') {
          if (method === 'POST') {
            const { handleSearchVectorStore } = await import('./routes/vector-stores.js')
            await handleSearchVectorStore(req, res, ctx, id)
            return true
          }
        } else if (sub === 'files') {
          if (method === 'POST') {
            const { handleAttachVectorStoreFile } = await import('./routes/vector-stores.js')
            await handleAttachVectorStoreFile(req, res, ctx, id)
            return true
          }
        }
      }

      const vectorStoreIdOnly = path.match(/^\/v1\/vector_stores\/([^/]+)$/)
      if (vectorStoreIdOnly) {
        const id = vectorStoreIdOnly[1] ?? ''
        if (method === 'GET') {
          const { handleGetVectorStore } = await import('./routes/vector-stores.js')
          await handleGetVectorStore(req, res, ctx, id)
          return true
        }
        if (method === 'POST') {
          const { handleUpdateVectorStore } = await import('./routes/vector-stores.js')
          await handleUpdateVectorStore(req, res, ctx, id)
          return true
        }
        if (method === 'DELETE') {
          const { handleDeleteVectorStore } = await import('./routes/vector-stores.js')
          await handleDeleteVectorStore(req, res, ctx, id)
          return true
        }
      }

      sendError(res, 404, 'not_found', `Unknown endpoint: ${method} ${path}`)
      return true
    }
  }
}
