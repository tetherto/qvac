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

      if (method === 'POST' && path === '/v1/chat/completions') {
        const { handleChatCompletions } = await import('./routes/chat.js')
        await handleChatCompletions(req, res, ctx)
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

      const vectorStoreMatch = path.match(/^\/v1\/vector_stores\/([^/]+)(?:\/(search))?$/)
      if (vectorStoreMatch) {
        const id = vectorStoreMatch[1] ?? ''
        const sub = vectorStoreMatch[2]
        if (sub === 'search') {
          if (method === 'POST') {
            const { handleSearchVectorStore } = await import('./routes/vector-stores.js')
            await handleSearchVectorStore(req, res, ctx, id)
            return true
          }
        } else {
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
      }

      sendError(res, 404, 'not_found', `Unknown endpoint: ${method} ${path}`)
      return true
    }
  }
}
