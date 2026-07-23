'use strict'

const { QvacErrorRAG, ERR_CODES } = require('./src/errors')

require('./src/types')

// RAG
const RAG = require('./src/RAG')

// Database Adapters
const BaseDBAdapter = require('./src/adapters/database/BaseDBAdapter')
const HyperDBAdapter = require('./src/adapters/database/HyperDBAdapter')

// Chunker Adapters
const BaseChunkAdapter = require('./src/adapters/chunker/BaseChunkAdapter')
const LLMChunkAdapter = require('./src/adapters/chunker/LLMChunkAdapter')

// LLM Adapters
const BaseLlmAdapter = require('./src/adapters/llm/BaseLlmAdapter')
const QvacLlmAdapter = require('./src/adapters/llm/QvacLlmAdapter')
const HttpLlmAdapter = require('./src/adapters/llm/HttpLlmAdapter')

// Schemas
const embeddingSchemas = require('./src/schemas/embedding')

module.exports = {
  RAG,
  HyperDBAdapter,
  LLMChunkAdapter,
  BaseDBAdapter,
  BaseChunkAdapter,
  BaseLlmAdapter,
  HttpLlmAdapter,
  QvacLlmAdapter,
  QvacErrorRAG,
  ERR_CODES,
  ...embeddingSchemas
}
