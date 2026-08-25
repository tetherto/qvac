import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import type { BaseChunkOpts, Doc } from '../../types.js'

// Abstract base class for text chunking implementations. Provides a common
// interface for different chunking strategies.
export abstract class BaseChunkAdapter {
  opts: BaseChunkOpts

  constructor(opts: BaseChunkOpts = {}) {
    if (new.target === BaseChunkAdapter) {
      throw new QvacErrorRAG({ code: ERR_CODES.ABSTRACT_CLASS })
    }
    this.opts = opts
  }

  // Chunks text(s) into smaller pieces. Subclasses must override.
  // lunte-disable-next-line require-await
  async chunkText(input: string | string[], opts: BaseChunkOpts = {}): Promise<Doc[]> {
    throw new QvacErrorRAG({ code: ERR_CODES.NOT_IMPLEMENTED })
  }

  validateInput(input: string | string[]): void {
    if (!input) {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'Input cannot be empty, null or undefined'
      })
    }

    if (typeof input === 'string') {
      if (input.trim().length === 0) {
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: 'Input string cannot be empty'
        })
      }
    } else if (Array.isArray(input)) {
      if (input.length === 0) {
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: 'Input array cannot be empty'
        })
      }

      for (let i = 0; i < input.length; i++) {
        if (typeof input[i] !== 'string') {
          throw new QvacErrorRAG({
            code: ERR_CODES.INVALID_INPUT,
            adds: `Input array element at index ${i} must be a string`
          })
        }
        if (input[i].trim().length === 0) {
          throw new QvacErrorRAG({
            code: ERR_CODES.INVALID_INPUT,
            adds: `Input array element at index ${i} cannot be empty`
          })
        }
      }
    } else {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'Input must be a string or array of strings'
      })
    }
  }

  // Merges new options into this chunker's defaults.
  updateOptions(opts: BaseChunkOpts = {}): void {
    if (!this.opts) {
      this.opts = {}
    }
    this.opts = { ...this.opts, ...opts }
  }

  getOptions(): BaseChunkOpts {
    return { ...this.opts }
  }
}
