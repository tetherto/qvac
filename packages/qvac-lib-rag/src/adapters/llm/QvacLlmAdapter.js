'use strict'

const BaseLlmAdapter = require('./BaseLlmAdapter')
const { QvacErrorRAG, ERR_CODES } = require('../../errors')

/**
 * QVAC-based LLM adapter that wraps QVAC LLM instances.
 */
class QvacLlmAdapter extends BaseLlmAdapter {
  /**
   * @param {QvacLlmAddon} llm - The QVAC LLM instance
   */
  constructor (llm) {
    super()

    if (!llm) {
      throw new QvacErrorRAG({ code: ERR_CODES.LLM_REQUIRED, adds: 'QVAC LLM instance is required' })
    }
    if (typeof llm.run !== 'function') {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'QVAC LLM must have a run method' })
    }
    this.llm = llm
  }

  /**
   * Run inference with the QVAC LLM using query and search results.
   * @param {string} query - The user query
   * @param {Array<SearchResult>} searchResults - Search results from the embedder
   * @param {Object} [opts] - Additional options for the inference
   * @returns {Promise<QvacResponse>} The generated response from QVAC
   * @throws {QvacErrorRAG} If the QVAC LLM inference fails
   */
  async run (query, searchResults, opts = {}) {
    if (!query || typeof query !== 'string') {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'Query must be a non-empty string' })
    }

    let contextString = ''
    if (searchResults && searchResults.length > 0) {
      contextString = searchResults
        .map(c => `[Relevance: ${Math.round(c.score * 100)}%]\n${c.content}`)
        .join('\n\n')
    }

    const systemPrompt = opts.systemPrompt ||
      'You are a helpful assistant. Base your answer ONLY on the provided context information. ' +
      "If no context is provided, say that you don't have enough information to answer. " +
      'Each context piece has a relevance score - use this to weight the importance of each piece.'

    const userPrompt = contextString.length > 0
      ? `Context:\n${contextString}\n\nQuestion: ${query}`
      : `Question: ${query}`

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    try {
      return await this.llm.run(messages, opts)
    } catch (error) {
      throw new QvacErrorRAG({ code: ERR_CODES.GENERATION_FAILED, adds: `QVAC LLM inference failed: ${error.message}`, cause: error })
    }
  }

  /**
   * Update the QVAC LLM instance.
   * @param {QvacLlmAddon} newQvacLlm - New QVAC LLM instance
   */
  updateLLM (newLLM) {
    if (!newLLM) {
      throw new QvacErrorRAG({ code: ERR_CODES.LLM_REQUIRED, adds: 'QVAC LLM instance is required' })
    }
    if (typeof newLLM.run !== 'function') {
      throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'QVAC LLM must have a run method' })
    }
    this.llm = newLLM
  }
}

module.exports = QvacLlmAdapter
