import { BaseChunkAdapter } from '../../adapters/chunker/BaseChunkAdapter.js'
import { LLMChunkAdapter } from '../../adapters/chunker/LLMChunkAdapter.js'
import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import QvacLogger from '@qvac/logging'
import type { LoggerInterface } from '@qvac/logging'
import type { BaseChunkOpts, Doc, LLMChunkOpts } from '../../types.js'

interface ChunkingServiceConfig {
  chunker?: BaseChunkAdapter
  chunkOpts?: BaseChunkOpts
  logger?: LoggerInterface
}

export class ChunkingService {
  chunker: BaseChunkAdapter
  chunkOpts: BaseChunkOpts
  logger: LoggerInterface

  constructor({ chunker, chunkOpts = {}, logger }: ChunkingServiceConfig) {
    if (chunker && !(chunker instanceof BaseChunkAdapter)) {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_CHUNKER })
    }

    this.chunker = chunker || new LLMChunkAdapter(chunkOpts as LLMChunkOpts)
    this.chunkOpts = chunkOpts
    this.logger = logger || new QvacLogger()
  }

  // Splits text into multiple chunks using the configured chunker.
  async chunkText(input: string | string[], opts: BaseChunkOpts = {}): Promise<Doc[]> {
    const inputCount = typeof input === 'string' ? 1 : input.length
    this.logger.debug(`Chunking ${inputCount} text(s)`)
    const startTime = Date.now()

    const chunkOpts = { ...this.chunkOpts, ...opts }
    const chunks = await this.chunker.chunkText(input, chunkOpts)

    const duration = Date.now() - startTime
    this.logger.info(`Chunking complete: ${chunks.length} chunk(s) in ${duration}ms`)

    return chunks
  }

  // Sets the chunker for the service.
  setChunker(chunker: BaseChunkAdapter, chunkOpts: BaseChunkOpts = {}): void {
    if (!(chunker instanceof BaseChunkAdapter)) {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_CHUNKER })
    }
    this.chunker = chunker
    this.chunkOpts = { ...this.chunkOpts, ...chunkOpts }
  }
}
