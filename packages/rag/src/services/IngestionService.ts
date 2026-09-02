import { normalizeDocs } from '../utils/helper.js'
import { QvacErrorRAG, ERR_CODES } from '../errors.js'
import { embeddedDocsArraySchema } from '../schemas/embedding.js'
import QvacLogger from '@qvac/logging'
import type { LoggerInterface } from '@qvac/logging'
import type { BaseDBAdapter } from '../adapters/database/BaseDBAdapter.js'
import type { ChunkingService } from './core/ChunkingService.js'
import type { EmbeddingService } from './core/EmbeddingService.js'
import type {
  BaseChunkOpts,
  Doc,
  EmbeddedDoc,
  IngestOpts,
  IngestResult,
  PartialDoc,
  SaveEmbeddingsOpts,
  SaveEmbeddingsResult,
  SaveStage
} from '../types.js'

interface ZodLikeError {
  name: string
  issues?: Array<{ message?: string }>
}

function isZodError(error: unknown): error is ZodLikeError {
  return (
    typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ZodError'
  )
}

interface IngestionServiceConfig {
  dbAdapter: BaseDBAdapter
  chunkingService: ChunkingService
  embeddingService: EmbeddingService
  logger?: LoggerInterface
}

export class IngestionService {
  dbAdapter: BaseDBAdapter
  chunkingService: ChunkingService
  embeddingService: EmbeddingService
  logger: LoggerInterface

  constructor({ dbAdapter, chunkingService, embeddingService, logger }: IngestionServiceConfig) {
    if (!dbAdapter) throw new QvacErrorRAG({ code: ERR_CODES.DB_ADAPTER_REQUIRED })
    if (!chunkingService) throw new QvacErrorRAG({ code: ERR_CODES.INVALID_CHUNKER })
    if (!embeddingService) throw new QvacErrorRAG({ code: ERR_CODES.EMBEDDING_FUNCTION_REQUIRED })

    this.dbAdapter = dbAdapter
    this.chunkingService = chunkingService
    this.embeddingService = embeddingService
    this.logger = logger || new QvacLogger()
  }

  // Chunks a large text into multiple chunks using the configured chunking options.
  // lunte-disable-next-line require-await
  async chunk(input: string | string[], opts: BaseChunkOpts = {}): Promise<Doc[]> {
    return this.chunkingService.chunkText(input, opts)
  }

  // Validate embedded docs structure.
  private validateEmbeddedDocs(embeddedDocs: EmbeddedDoc[]): void {
    try {
      embeddedDocsArraySchema.parse(embeddedDocs)
    } catch (error) {
      if (isZodError(error)) {
        const zodIssue = error.issues?.[0]
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: `Embedded document validation failed: ${zodIssue?.message || 'Invalid embedded documents'}`,
          cause: error instanceof Error ? error : undefined
        })
      }
      throw error
    }
  }

  // Save embedded documents directly to the vector database. Documents must
  // have id, content, embedding, and embeddingModelId fields.
  // lunte-disable-next-line require-await
  async saveEmbeddings(
    embeddedDocs: EmbeddedDoc[],
    opts: SaveEmbeddingsOpts = {}
  ): Promise<SaveEmbeddingsResult[]> {
    const { onProgress, signal, dbOpts } = opts

    this.validateEmbeddedDocs(embeddedDocs)

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    return this.dbAdapter.saveEmbeddings(embeddedDocs, {
      ...dbOpts,
      onProgress,
      signal
    })
  }

  // Ingest documents: chunk, embed, and save to the vector database. Convenience
  // method that handles the full pipeline.
  async ingest(
    docs: string | Array<string | PartialDoc>,
    embeddingModelId: string,
    opts: IngestOpts = {}
  ): Promise<IngestResult> {
    const { onProgress, signal, dbOpts, chunkOpts, progressInterval } = opts
    if (opts.chunk === undefined) opts.chunk = true

    if (!embeddingModelId || typeof embeddingModelId !== 'string') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_PARAMS,
        adds: 'embeddingModelId is required and must be a string'
      })
    }

    // Prepare documents: convert to {id, content} objects
    let preparedDocs: Doc[] | null = null
    let droppedIndices: number[] = []

    const inputDocs = typeof docs === 'string' ? [docs] : docs
    const inputCount = inputDocs.length
    this.logger.info(`Starting ingestion of ${inputCount} document(s)`)

    if (opts.chunk) {
      if (signal?.aborted) {
        throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
      }

      this.logger.debug('Phase: Chunking')
      onProgress?.('chunking', 0, inputCount)
      preparedDocs = await this.chunkingService.chunkText(docs as string | string[], chunkOpts)
      onProgress?.('chunking', inputCount, inputCount)
    } else {
      const result = normalizeDocs(inputDocs)
      preparedDocs = result.normalizedDocs
      droppedIndices = result.droppedIndices
    }

    if (preparedDocs.length === 0) {
      this.logger.warn('No documents to ingest after preparation')
      return {
        processed: [],
        droppedIndices
      }
    }

    // Phase 2: Embedding
    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.debug('Phase: Embedding')
    const embeddingMap = await this.embeddingService.generateEmbeddingsForDocs(preparedDocs, {
      onProgress: (current, total) => {
        onProgress?.('embedding', current, total)
      },
      signal
    })

    // Attach embeddings to documents
    const embeddedDocs: EmbeddedDoc[] = preparedDocs.map((doc) => ({
      ...doc,
      embeddingModelId,
      embedding: embeddingMap[doc.id]
    }))

    // Phase 3: Saving
    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.debug('Phase: Saving')
    const processed = await this.dbAdapter.saveEmbeddings(embeddedDocs, {
      ...dbOpts,
      progressInterval,
      onProgress: (stage: SaveStage, current: number, total: number) => {
        onProgress?.(`saving:${stage}`, current, total)
      },
      signal
    })

    this.logger.info(
      `Ingestion complete: ${processed.length} saved, ${droppedIndices.length} dropped`
    )

    return {
      processed,
      droppedIndices
    }
  }

  // Delete embeddings for a set of documents inside the vector database.
  // lunte-disable-next-line require-await
  async deleteEmbeddings(ids: string[]): Promise<boolean> {
    return this.dbAdapter.deleteEmbeddings(ids)
  }
}
