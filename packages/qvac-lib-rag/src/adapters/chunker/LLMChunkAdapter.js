'use strict'

const BaseChunkAdapter = require('./BaseChunkAdapter')
const { QvacErrorRAG, ERR_CODES } = require('../../errors')
const { generateId } = require('../../utils/helper')
const { tokenizeText } = require('./Tokenizer')

let _llmSplitterSplit = null

async function getLLMSplitter () {
  if (!_llmSplitterSplit) {
    try {
      const llmSplitter = await import('llm-splitter')
      _llmSplitterSplit = llmSplitter.split
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND') {
        throw new QvacErrorRAG({
          code: ERR_CODES.DEPENDENCY_REQUIRED,
          adds: 'llm-splitter is required for LLMChunkAdapter.',
          cause: error
        })
      }
      throw error
    }
  }
  return _llmSplitterSplit
}

/**
 * Predefined splitter strategies for common tokenization needs.
 */
const PREDEFINED_SPLITTERS = {
  character: text => text.split(''),
  word: text => text.split(/\s+/).filter(word => word.length > 0),
  sentence: text => text.split(/[.!?]+/).filter(s => s.trim().length > 0),
  line: text => text.split(/\n/),
  token: text => tokenizeText(text).tokens.map(t => t.text)
}

/**
 * Chunking implementation using the llm-splitter library.
 * Provides predefined split strategies (character, word, token, sentence, line) and supports custom splitters.
 */
class LLMChunkAdapter extends BaseChunkAdapter {
  constructor (opts = {}) {
    super()
    const defaultOpts = {
      chunkSize: 256,
      chunkOverlap: 50,
      chunkStrategy: 'paragraph'
    }

    if (!opts.splitStrategy && !opts.splitter) {
      defaultOpts.splitStrategy = 'token'
    }

    this.opts = { ...defaultOpts, ...opts }
  }

  /**
   * Chunks text(s) using the llm-splitter library.
   * Supports predefined split strategies (character, word, token, sentence, line) or custom splitter functions.
   * @param {string|Array<string>} input - The text or array of texts to chunk.
   * @param {LLMChunkOpts} opts - Chunking options.
   * @returns {Promise<Array<Doc>>} - Array of chunk objects with content and id.
   */
  async chunkText (input, opts = {}) {
    try {
      this.validateInput(input)

      const chunkOptions = { ...this.opts, ...opts }

      if (chunkOptions.splitStrategy && !PREDEFINED_SPLITTERS[chunkOptions.splitStrategy]) {
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_PARAMS,
          adds: `splitStrategy must be one of: ${Object.keys(PREDEFINED_SPLITTERS).join(', ')}, received: ${chunkOptions.splitStrategy}`
        })
      }

      if (!chunkOptions.splitter) {
        if (chunkOptions.splitStrategy) {
          chunkOptions.splitter = PREDEFINED_SPLITTERS[chunkOptions.splitStrategy]
        } else {
          chunkOptions.splitter = PREDEFINED_SPLITTERS.token
        }
      }

      delete chunkOptions.splitStrategy

      const split = await getLLMSplitter()
      const chunks = split(input, chunkOptions)
      return this._processChunks(chunks)
    } catch (error) {
      if (error instanceof QvacErrorRAG) {
        throw error
      }
      throw new QvacErrorRAG({ code: ERR_CODES.CHUNKING_FAILED, adds: `Failed to chunk text: ${error.message}`, cause: error })
    }
  }

  /**
   * Process chunks from llm-splitter into Doc objects.
   * @param {Array} chunks - The chunks from llm-splitter.
   * @returns {Array<Doc>} Array of Doc objects.
   * @private
   */
  _processChunks (chunks) {
    const result = []
    for (const chunk of chunks) {
      if (Array.isArray(chunk.text)) {
        for (const text of chunk.text) {
          result.push({
            id: generateId(),
            content: text
          })
        }
      } else {
        result.push({
          id: generateId(),
          content: chunk.text
        })
      }
    }
    return result
  }
}

module.exports = LLMChunkAdapter
