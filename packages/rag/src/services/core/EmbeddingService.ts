import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import {
  embeddingInputSchema,
  singleEmbeddingSchema,
  batchEmbeddingSchema,
  docsArraySchema
} from '../../schemas/embedding.js'
import QvacLogger from '@qvac/logging'
import type { LoggerInterface } from '@qvac/logging'
import type { Doc, EmbeddingFunction, EmbeddingOpts } from '../../types.js'

interface ZodLikeError {
  name: string
  issues?: Array<{ message?: string }>
}

function isZodError(error: unknown): error is ZodLikeError {
  return (
    typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ZodError'
  )
}

interface EmbeddingServiceConfig {
  embeddingFunction: EmbeddingFunction
  logger?: LoggerInterface
}

export class EmbeddingService {
  embeddingFunction: EmbeddingFunction
  logger: LoggerInterface

  constructor({ embeddingFunction, logger }: EmbeddingServiceConfig) {
    if (!embeddingFunction || typeof embeddingFunction !== 'function') {
      throw new QvacErrorRAG({
        code: ERR_CODES.EMBEDDING_FUNCTION_REQUIRED,
        adds: 'embeddingFunction must be a function that takes text and returns an array of numbers'
      })
    }
    this.embeddingFunction = embeddingFunction
    this.logger = logger || new QvacLogger()
  }

  // Generate embeddings for a single text or a batch of texts.
  async generateEmbeddings(text: string): Promise<number[]>
  async generateEmbeddings(text: string[]): Promise<number[][]>
  async generateEmbeddings(text: string | string[]): Promise<number[] | number[][]> {
    let validatedInput: string | string[]
    try {
      validatedInput = embeddingInputSchema.parse(text)
    } catch (error) {
      if (isZodError(error)) {
        const zodIssue = error.issues?.[0]
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: `Input validation failed: ${zodIssue?.message || 'Invalid input'}`,
          cause: error instanceof Error ? error : undefined
        })
      }
      throw error
    }

    let embeddings: number[] | number[][]
    try {
      embeddings = await this.embeddingFunction(validatedInput)
    } catch (error) {
      if (error instanceof QvacErrorRAG) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new QvacErrorRAG({
        code: ERR_CODES.GENERATION_FAILED,
        adds: `Failed to generate embeddings: ${message}`,
        cause: error instanceof Error ? error : undefined
      })
    }

    try {
      if (Array.isArray(validatedInput)) {
        batchEmbeddingSchema.parse(embeddings)
      } else {
        singleEmbeddingSchema.parse(embeddings)
      }
    } catch (error) {
      if (isZodError(error)) {
        const zodIssue = error.issues?.[0]
        throw new QvacErrorRAG({
          code: ERR_CODES.GENERATION_FAILED,
          adds: `Embedding function returned invalid output: ${zodIssue?.message || 'Invalid output format'}`,
          cause: error instanceof Error ? error : undefined
        })
      }
      throw error
    }

    return embeddings
  }

  // Generate embeddings for multiple documents with IDs, returning a map of
  // document IDs to embeddings. Batch embedding is atomic: it reports only
  // start/end, not incremental progress.
  async generateEmbeddingsForDocs(
    docs: Doc[],
    opts: EmbeddingOpts = {}
  ): Promise<{ [key: string]: number[] }> {
    let validatedDocs: Doc[]
    try {
      validatedDocs = docsArraySchema.parse(docs)
    } catch (error) {
      if (isZodError(error)) {
        const zodIssue = error.issues?.[0]
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: `Document validation failed: ${zodIssue?.message || 'Invalid documents'}`,
          cause: error instanceof Error ? error : undefined
        })
      }
      throw error
    }

    const { onProgress, signal } = opts

    if (signal?.aborted) {
      throw new QvacErrorRAG({ code: ERR_CODES.OPERATION_CANCELLED })
    }

    this.logger.debug(`Generating embeddings for ${validatedDocs.length} document(s)`)

    const allTexts = validatedDocs.map((doc) => doc.content)

    onProgress?.(0, validatedDocs.length)

    let batchEmbeddings: number[] | number[][]
    try {
      batchEmbeddings = await this.embeddingFunction(allTexts)
    } catch (error) {
      if (error instanceof QvacErrorRAG) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new QvacErrorRAG({
        code: ERR_CODES.GENERATION_FAILED,
        adds: `Failed to generate batch embeddings: ${message}`,
        cause: error instanceof Error ? error : undefined
      })
    }

    try {
      batchEmbeddingSchema.parse(batchEmbeddings)
    } catch (error) {
      if (isZodError(error)) {
        const zodIssue = error.issues?.[0]
        throw new QvacErrorRAG({
          code: ERR_CODES.GENERATION_FAILED,
          adds: `Embedding function returned invalid batch output: ${zodIssue?.message || 'Invalid output format'}`,
          cause: error instanceof Error ? error : undefined
        })
      }
      throw error
    }

    const batch = batchEmbeddings as number[][]
    const embeddings: { [key: string]: number[] } = {}
    validatedDocs.forEach((doc, idx) => {
      embeddings[doc.id] = batch[idx]
    })

    this.logger.debug(`Embeddings generated: ${Object.keys(embeddings).length}`)

    onProgress?.(validatedDocs.length, validatedDocs.length)

    return embeddings
  }
}
