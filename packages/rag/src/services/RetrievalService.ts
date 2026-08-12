import { normalizeDocs } from '../utils/helper.js'
import { QvacErrorRAG, ERR_CODES } from '../errors.js'
import QvacLogger from '@qvac/logging'
import type { LoggerInterface } from '@qvac/logging'
import type { BaseDBAdapter } from '../adapters/database/BaseDBAdapter.js'
import type { ChunkingService } from './core/ChunkingService.js'
import type { EmbeddingService } from './core/EmbeddingService.js'
import type { Doc, GenerateEmbeddingsOpts, SearchParams, SearchResult } from '../types.js'

interface RetrievalServiceConfig {
  dbAdapter: BaseDBAdapter
  chunkingService: ChunkingService
  embeddingService: EmbeddingService
  logger?: LoggerInterface
}

export class RetrievalService {
  dbAdapter: BaseDBAdapter
  chunkingService: ChunkingService
  embeddingService: EmbeddingService
  logger: LoggerInterface

  constructor({ dbAdapter, chunkingService, embeddingService, logger }: RetrievalServiceConfig) {
    if (!dbAdapter) throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_REQUIRED })
    if (!chunkingService) throw new QvacErrorRAG({ code: ERR_CODES.INVALID_CHUNKER })
    if (!embeddingService) throw new QvacErrorRAG({ code: ERR_CODES.EMBEDDING_FUNCTION_REQUIRED })

    this.dbAdapter = dbAdapter
    this.chunkingService = chunkingService
    this.embeddingService = embeddingService
    this.logger = logger || new QvacLogger()
  }

  // Generate embeddings for a text.
  // lunte-disable-next-line require-await
  async generateEmbeddings(text: string): Promise<number[]> {
    return this.embeddingService.generateEmbeddings(text)
  }

  // Generate embeddings for a set of documents, returning a map of document IDs
  // to their embeddings.
  async generateEmbeddingsForDocs(
    docs: string | string[],
    opts: GenerateEmbeddingsOpts = {}
  ): Promise<{ [key: string]: number[] }> {
    const { signal, chunk = true, chunkOpts } = opts

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    let normalizedDocs: Doc[] | null = null
    if (chunk) {
      normalizedDocs = await this.chunkingService.chunkText(docs, chunkOpts)
    } else {
      const docsToNormalize = typeof docs === 'string' ? [docs] : docs
      const result = normalizeDocs(docsToNormalize)
      normalizedDocs = result.normalizedDocs
    }

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    return this.embeddingService.generateEmbeddingsForDocs(normalizedDocs, { signal })
  }

  // Search for documents based on a query string.
  async search(query: string, params: SearchParams = {}): Promise<SearchResult[]> {
    const { signal } = params

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.debug(
      `Search started: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`
    )
    const startTime = Date.now()

    if (typeof query !== 'string' || query.trim() === '') {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT })
    }
    const queryVector = await this.embeddingService.generateEmbeddings(query)

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    const results = await this.dbAdapter.search(query, queryVector, params)
    const duration = Date.now() - startTime

    this.logger.info(`Search complete: ${results.length} result(s) in ${duration}ms`)

    return results
  }
}
