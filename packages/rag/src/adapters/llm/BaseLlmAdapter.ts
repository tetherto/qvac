import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import type { InferOpts, SearchResult } from '../../types.js'

// Abstract base class for LLM implementations. Provides a common interface for
// different LLM types (QVAC-based, HTTP-based, etc.).
export abstract class BaseLlmAdapter {
  constructor() {
    if (new.target === BaseLlmAdapter) {
      throw new QvacErrorRAG({
        code: ERR_CODES.ABSTRACT_CLASS,
        adds: 'BaseLlmAdapter cannot be instantiated directly'
      })
    }
  }

  // Run inference with the LLM using query and search results. Subclasses must override.
  // lunte-disable-next-line no-unused-vars,require-await
  async run(query: string, searchResults: SearchResult[], opts: InferOpts = {}): Promise<unknown> {
    throw new QvacErrorRAG({
      code: ERR_CODES.NOT_IMPLEMENTED,
      adds: 'run method must be implemented by concrete adapter classes'
    })
  }
}
