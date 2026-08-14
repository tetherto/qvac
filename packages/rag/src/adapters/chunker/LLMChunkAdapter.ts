import { split, type Chunk } from 'llm-splitter'

import { BaseChunkAdapter } from './BaseChunkAdapter.js'
import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import { generateId } from '../../utils/helper.js'
import { tokenizeText } from './Tokenizer.js'
import type { Doc, LLMChunkOpts } from '../../types.js'

// Predefined splitter strategies for common tokenization needs.
const PREDEFINED_SPLITTERS: Record<string, (text: string) => string[]> = {
  character: (text) => text.split(''),
  word: (text) => text.split(/\s+/).filter((word) => word.length > 0),
  sentence: (text) => text.split(/[.!?]+/).filter((s) => s.trim().length > 0),
  line: (text) => text.split(/\n/),
  token: (text) => tokenizeText(text).tokens.map((t) => t.text)
}

// Chunking implementation using the llm-splitter library. Provides predefined
// split strategies (character, word, token, sentence, line) and custom splitters.
export class LLMChunkAdapter extends BaseChunkAdapter {
  constructor(opts: LLMChunkOpts = {}) {
    super()
    const defaultOpts: LLMChunkOpts = {
      chunkSize: 256,
      chunkOverlap: 50,
      chunkStrategy: 'paragraph'
    }

    if (!opts.splitStrategy && !opts.splitter) {
      defaultOpts.splitStrategy = 'token'
    }

    this.opts = { ...defaultOpts, ...opts }
  }

  // lunte-disable-next-line require-await
  override async chunkText(input: string | string[], opts: LLMChunkOpts = {}): Promise<Doc[]> {
    try {
      this.validateInput(input)

      const chunkOptions: LLMChunkOpts = { ...this.opts, ...opts }

      if (chunkOptions.splitStrategy && !PREDEFINED_SPLITTERS[chunkOptions.splitStrategy]) {
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_PARAMS,
          adds: `splitStrategy must be one of: ${Object.keys(PREDEFINED_SPLITTERS).join(', ')}, received: ${chunkOptions.splitStrategy}`
        })
      }

      if (!chunkOptions.splitter) {
        chunkOptions.splitter = chunkOptions.splitStrategy
          ? PREDEFINED_SPLITTERS[chunkOptions.splitStrategy]
          : PREDEFINED_SPLITTERS.token
      }

      delete chunkOptions.splitStrategy

      const chunks = split(input, chunkOptions)
      return this.processChunks(chunks)
    } catch (error) {
      if (error instanceof QvacErrorRAG) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new QvacErrorRAG({
        code: ERR_CODES.CHUNKING_FAILED,
        adds: `Failed to chunk text: ${message}`,
        cause: error instanceof Error ? error : undefined
      })
    }
  }

  // Process chunks from llm-splitter into Doc objects. A chunk's text is null
  // for discarded segments, which produce no document.
  private processChunks(chunks: Chunk[]): Doc[] {
    const result: Doc[] = []
    for (const chunk of chunks) {
      if (chunk.text === null) continue
      if (Array.isArray(chunk.text)) {
        for (const text of chunk.text) {
          result.push({ id: generateId(), content: text })
        }
      } else {
        result.push({ id: generateId(), content: chunk.text })
      }
    }
    return result
  }
}
