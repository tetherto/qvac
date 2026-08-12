import { BaseLlmAdapter } from './BaseLlmAdapter.js'
import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import type { InferOpts, QvacLlmAddon, QvacResponse, SearchResult } from '../../types.js'

// QVAC-based LLM adapter that wraps QVAC LLM instances.
export class QvacLlmAdapter extends BaseLlmAdapter {
  llm: QvacLlmAddon

  constructor(llm: QvacLlmAddon) {
    super()

    if (!llm) {
      throw new QvacErrorRAG({
        code: ERR_CODES.LLM_REQUIRED,
        adds: 'QVAC LLM instance is required'
      })
    }
    if (typeof llm.run !== 'function') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'QVAC LLM must have a run method'
      })
    }
    this.llm = llm
  }

  override async run(
    query: string,
    searchResults: SearchResult[],
    opts: InferOpts = {}
  ): Promise<QvacResponse> {
    if (!query || typeof query !== 'string') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'Query must be a non-empty string'
      })
    }

    let contextString = ''
    if (searchResults && searchResults.length > 0) {
      contextString = searchResults
        .map((c) => `[Relevance: ${Math.round(c.score * 100)}%]\n${c.content}`)
        .join('\n\n')
    }

    const systemPrompt =
      opts.systemPrompt ||
      'You are a helpful assistant. Base your answer ONLY on the provided context information. ' +
        "If no context is provided, say that you don't have enough information to answer. " +
        'Each context piece has a relevance score - use this to weight the importance of each piece.'

    const userPrompt =
      contextString.length > 0
        ? `Context:\n${contextString}\n\nQuestion: ${query}`
        : `Question: ${query}`

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    try {
      return await this.llm.run(messages, opts)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new QvacErrorRAG({
        code: ERR_CODES.GENERATION_FAILED,
        adds: `QVAC LLM inference failed: ${message}`,
        cause: error instanceof Error ? error : undefined
      })
    }
  }

  updateLLM(newLLM: QvacLlmAddon): void {
    if (!newLLM) {
      throw new QvacErrorRAG({
        code: ERR_CODES.LLM_REQUIRED,
        adds: 'QVAC LLM instance is required'
      })
    }
    if (typeof newLLM.run !== 'function') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'QVAC LLM must have a run method'
      })
    }
    this.llm = newLLM
  }
}
