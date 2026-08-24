import ReadyResource from 'ready-resource'
import QvacLogger from '@qvac/logging'
import type { LoggerInterface } from '@qvac/logging'

import { IngestionService } from './services/IngestionService.js'
import { RetrievalService } from './services/RetrievalService.js'
import { ChunkingService } from './services/core/ChunkingService.js'
import { EmbeddingService } from './services/core/EmbeddingService.js'
import { BaseLlmAdapter } from './adapters/llm/BaseLlmAdapter.js'
import { QvacErrorRAG, ERR_CODES } from './errors.js'
import type { BaseChunkAdapter } from './adapters/chunker/BaseChunkAdapter.js'
import type { BaseDBAdapter } from './adapters/database/BaseDBAdapter.js'
import type {
  BaseChunkOpts,
  BaseDBAdapterConfig,
  Doc,
  EmbeddedDoc,
  EmbeddingFunction,
  GenerateEmbeddingsOpts,
  IngestOpts,
  IngestResult,
  InferOpts,
  PartialDoc,
  ReindexOpts,
  ReindexResult,
  SaveEmbeddingsOpts,
  SaveEmbeddingsResult,
  SearchParams,
  SearchResult
} from './types.js'

export interface RAGConfig {
  embeddingFunction: EmbeddingFunction
  dbAdapter: BaseDBAdapter
  llm?: BaseLlmAdapter
  chunker?: BaseChunkAdapter
  chunkOpts?: BaseChunkOpts
  logger?: LoggerInterface
}

// RAG (Retrieval-Augmented Generation) orchestrator: wires chunking, embedding,
// ingestion and retrieval around a vector database adapter.
export class RAG extends ReadyResource {
  logger: LoggerInterface
  dbAdapter: BaseDBAdapter
  llmAdapter: BaseLlmAdapter | undefined
  private chunkingService: ChunkingService
  private embeddingService: EmbeddingService
  private ingestionService: IngestionService
  private retrievalService: RetrievalService

  constructor({ llm, embeddingFunction, dbAdapter, chunker, chunkOpts = {}, logger }: RAGConfig) {
    super()
    if (!embeddingFunction) throw new QvacErrorRAG({ code: ERR_CODES.EMBEDDING_FUNCTION_REQUIRED })
    if (!dbAdapter) throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_REQUIRED })

    this.logger = logger || new QvacLogger()

    this.chunkingService = new ChunkingService({ chunker, chunkOpts, logger: this.logger })
    this.embeddingService = new EmbeddingService({ embeddingFunction, logger: this.logger })
    this.ingestionService = new IngestionService({
      dbAdapter,
      chunkingService: this.chunkingService,
      embeddingService: this.embeddingService,
      logger: this.logger
    })
    this.retrievalService = new RetrievalService({
      dbAdapter,
      chunkingService: this.chunkingService,
      embeddingService: this.embeddingService,
      logger: this.logger
    })
    this.dbAdapter = dbAdapter
    this.llmAdapter = llm

    this.logger.debug('RAG instance created')
  }

  // lunte-disable-next-line require-await
  async chunk(input: string | string[], opts: BaseChunkOpts = {}): Promise<Doc[]> {
    return this.chunkingService.chunkText(input, opts)
  }

  // lunte-disable-next-line require-await
  async generateEmbeddings(text: string): Promise<number[]> {
    return this.embeddingService.generateEmbeddings(text)
  }

  // lunte-disable-next-line require-await
  async generateEmbeddingsForDocs(
    docs: string | string[],
    opts: GenerateEmbeddingsOpts = {}
  ): Promise<{ [key: string]: number[] }> {
    return this.retrievalService.generateEmbeddingsForDocs(docs, opts)
  }

  // lunte-disable-next-line require-await
  async saveEmbeddings(
    embeddedDocs: EmbeddedDoc[],
    opts: SaveEmbeddingsOpts = {}
  ): Promise<SaveEmbeddingsResult[]> {
    return this.ingestionService.saveEmbeddings(embeddedDocs, opts)
  }

  // lunte-disable-next-line require-await
  async ingest(
    docs: string | Array<string | PartialDoc>,
    embeddingModelId: string,
    opts: IngestOpts = {}
  ): Promise<IngestResult> {
    return this.ingestionService.ingest(docs, embeddingModelId, opts)
  }

  // lunte-disable-next-line require-await
  async deleteEmbeddings(ids: string[]): Promise<boolean> {
    return this.ingestionService.deleteEmbeddings(ids)
  }

  async infer(query: string, opts: InferOpts = {}): Promise<unknown> {
    const { llmAdapter = this.llmAdapter, signal, ...rest } = opts
    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }
    if (!llmAdapter || !(llmAdapter instanceof BaseLlmAdapter)) {
      throw new QvacErrorRAG({ code: ERR_CODES.LLM_REQUIRED })
    }

    if (typeof query !== 'string' || query.trim() === '') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'query must be a non-empty string'
      })
    }

    this.logger.debug(`Infer started: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`)
    const startTime = Date.now()

    const searchResults = await this.retrievalService.search(query, { signal, ...rest })
    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }
    if (searchResults.length === 0) {
      this.logger.debug('Infer: no context found')
      return null
    }

    const result = await llmAdapter.run(query, searchResults, { signal, ...rest })
    const duration = Date.now() - startTime

    this.logger.info(`Infer complete: ${searchResults.length} context(s) in ${duration}ms`)

    return result
  }

  // lunte-disable-next-line require-await
  async search(query: string, params: SearchParams = {}): Promise<SearchResult[]> {
    return this.retrievalService.search(query, params)
  }

  setChunker(chunker: BaseChunkAdapter, chunkOpts: BaseChunkOpts = {}): void {
    this.chunkingService.setChunker(chunker, chunkOpts)
  }

  setLlm(llmAdapter: BaseLlmAdapter): void {
    if (!llmAdapter || !(llmAdapter instanceof BaseLlmAdapter)) {
      throw new QvacErrorRAG({ code: ERR_CODES.LLM_REQUIRED })
    }
    this.llmAdapter = llmAdapter
  }

  reindex(opts?: ReindexOpts): Promise<ReindexResult> {
    return this.dbAdapter.reindex(opts)
  }

  // lunte-disable-next-line require-await
  async getDBConfig(): Promise<BaseDBAdapterConfig | null> {
    return this.dbAdapter.getConfig()
  }

  override async _open(): Promise<void> {
    this.logger.info('Initializing RAG...')
    await this.dbAdapter.ready()
    this.logger.info('RAG ready')
  }

  override async _close(): Promise<void> {
    this.logger.info('Closing RAG...')
    await this.dbAdapter.close()
    this.logger.debug('RAG closed')
  }
}
