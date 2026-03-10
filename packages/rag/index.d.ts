import QvacResponse = require("@qvac/response");
import ReadyResource = require("ready-resource");
import { QvacErrorBase } from "@qvac/error";
import type { LoggerInterface } from "@qvac/logging";

type Logger = LoggerInterface;

export interface Doc {
  id: string;
  content: string;
}

export interface EmbeddedDoc extends Doc {
  embedding: number[];
  embeddingModelId: string;
  metadata?: Record<string, any> | undefined;
}

export interface PartialDoc {
  content: string;
  id?: string;
}

export interface SaveEmbeddingsResult {
  status: "fulfilled" | "rejected";
  id?: string | undefined;
  error?: string | undefined;
}

export interface IngestResult {
  processed: SaveEmbeddingsResult[];
  droppedIndices: number[];
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
}

export interface BaseDBAdapterConfig {
  embeddingModelId: string;
  dimension: number;
  createdAt: Date;
}

export interface HyperDBAdapterConfig extends BaseDBAdapterConfig {
  key: string;
  NUM_CENTROIDS: number;
  BUCKET_SIZE: number;
  BATCH_SIZE: number;
}

export interface SearchParams {
  topK?: number; // Number of top results to retrieve from the database.
  n?: number; // Number of centroids to use for IVF index search.
  signal?: AbortSignal;
}

export interface BaseChunkOpts {
  [key: string]: unknown;
}

export interface DbOpts {
  [key: string]: unknown;
}

export interface LLMChunkOpts extends BaseChunkOpts {
  chunkSize?: number | undefined; // Maximum size of each chunk in tokens. (default: 256)
  chunkOverlap?: number | undefined; // Number of tokens to overlap between chunks. (default: 50)
  chunkStrategy?: "character" | "paragraph" | undefined; // Chunking strategy to use. Determines how chunks are grouped (default: 'paragraph')
  splitStrategy?: "character" | "token" | "word" | "sentence" | "line" | undefined; // Predefined split strategy for tokenization. If both splitter and splitStrategy are provided, splitter takes precedence. (default: 'token')
  splitter?: ((text: string) => string[]) | undefined; // Custom function to split text into tokens. If provided, takes precedence over splitStrategy.
}

export interface EmbeddingOpts {
  onProgress?: (current: number, total: number) => void;
  signal?: AbortSignal;
}

export interface GenerateEmbeddingsOpts {
  chunk?: boolean;
  chunkOpts?: BaseChunkOpts;
  signal?: AbortSignal;
}

export type SaveStage = "deduplicating" | "preparing" | "writing";

export interface SaveEmbeddingsOpts {
  dbOpts?: DbOpts | undefined;
  onProgress?: ((stage: SaveStage, current: number, total: number) => void) | undefined;
  progressInterval?: number | undefined;
  signal?: AbortSignal | undefined;
}

export type IngestStage =
  | "chunking"
  | "embedding"
  | "saving:deduplicating"
  | "saving:preparing"
  | "saving:writing";

export interface IngestOpts {
  chunk?: boolean | undefined;
  chunkOpts?: BaseChunkOpts | undefined;
  dbOpts?: DbOpts | undefined;
  onProgress?: ((stage: IngestStage, current: number, total: number) => void) | undefined;
  progressInterval?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface InferOpts extends SearchParams {
  llmAdapter?: BaseLlmAdapter;
  systemPrompt?: string;
}

export type ReindexStage =
  | "collecting"
  | "clustering"
  | "reassigning"
  | "updating";

export interface ReindexOpts {
  onProgress?: ((stage: ReindexStage, current: number, total: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface ReindexResult {
  reindexed: boolean;
  details?: Record<string, any> | undefined;
}

export interface QvacLlmAddon {
  /**
   * Run LLM inference with messages and options
   * @param messages - Array of message objects with role and content
   * @param opts - Additional options for inference
   * @returns The generated response.
   */
  run(
    messages: Array<{ role: string; content: string }>,
    opts?: object
  ): Promise<QvacResponse>;
}

export type EmbeddingFunction = (
  text: string | string[]
) => Promise<number[] | number[][]>;

/**
 * Abstract class for the database adapter.
 */
declare abstract class BaseDBAdapter extends ReadyResource {
  isInitialized: boolean; // Indicates whether the adapter has been initialized.

  /**
   * Save embeddings for a set of documents inside the vector database.
   * @param embeddedDocs - Documents with embeddings to be processed.
   * @param opts - Options for the processing.
   * @returns Array of processing results.
   */
  abstract saveEmbeddings(
    embeddedDocs: EmbeddedDoc[],
    opts?: SaveEmbeddingsOpts
  ): Promise<SaveEmbeddingsResult[]>;

  /**
   * Delete embeddings for a set of documents inside the vector database.
   * @param ids - The ids of the documents to be deleted.
   * @returns True if the embeddings were deleted
   */
  abstract deleteEmbeddings(ids: string[]): Promise<boolean>;

  /**
   * Search for documents based on a query string.
   * @param query - The search query.
   * @param params - The parameters for the search.
   * @returns An array of search results.
   */
  abstract search(
    query: string,
    queryVector: number[],
    params?: SearchParams
  ): Promise<SearchResult[]>;

  /**
   * Reindex the database to optimize search performance.
   * Default implementation returns not reindexed. Adapters can override.
   * @param opts - Options for reindexing.
   * @returns Reindexing result.
   */
  reindex(opts?: ReindexOpts): Promise<ReindexResult>;

  /**
   * Get stored adapter configuration.
   * @returns The stored config or null if not configured
   */
  getConfig(): Promise<BaseDBAdapterConfig | null>;
}

/**
 * Abstract class for the chunk adapter.
 */
declare abstract class BaseChunkAdapter {
  opts: BaseChunkOpts;

  /**
   * Splits text into multiple chunks.
   * @param input - The text to chunk.
   * @param opts - The options for the chunking.
   * @returns An array of chunk results.
   */
  abstract chunkText(
    input: string | string[],
    opts?: BaseChunkOpts
  ): Promise<Doc[]>;
}

/**
 * Abstract base class for LLM adapters.
 */
declare abstract class BaseLlmAdapter {
  /**
   * Run inference with the LLM using query and search results.
   * @param query - The user query
   * @param searchResults - Search results from the embedder
   * @param opts - Additional options for the inference
   * @returns The generated response (format depends on LLM adapter implementation)
   */
  abstract run(
    query: string,
    searchResults: SearchResult[],
    opts?: InferOpts
  ): Promise<any>;
}

/**
 * HTTP-based LLM adapter.
 */
declare class HttpLlmAdapter extends BaseLlmAdapter {
  /**
   * @param httpConfig - Configuration for the LLM API
   * @param requestBodyFormatter - Function that takes input(query & searchResults) and returns the request body
   * @param responseBodyFormatter - Function that takes API response and returns the final result
   */
  constructor(
    httpConfig: {
      apiUrl: string;
      method?: string;
      headers?: Record<string, string>;
    },
    requestBodyFormatter: (
      query: string,
      searchResults: SearchResult[],
      opts?: object
    ) => object,
    responseBodyFormatter: (response: unknown) => unknown
  );

  run(
    query: string,
    searchResults: SearchResult[],
    opts?: InferOpts
  ): Promise<any>;
  updateHttpConfig(newHttpConfig: object): void;
  updateRequestBodyFormatter(
    newFormatter: (
      query: string,
      searchResults: SearchResult[],
      opts?: object
    ) => object
  ): void;
  updateResponseBodyFormatter(
    newFormatter: (response: unknown) => unknown
  ): void;
}

/**
 * QVAC-based LLM adapter.
 */
declare class QvacLlmAdapter extends BaseLlmAdapter {
  /**
   * @param llm - The QVAC LLM instance
   */
  constructor(llm: QvacLlmAddon);
  run(
    query: string,
    searchResults: SearchResult[],
    opts?: object
  ): Promise<QvacResponse>;
  updateLLM(newLLM: QvacLlmAddon): void;
}

/**
 * RAG (Retrieval-Augmented Generation) class.
 */
declare class RAG extends ReadyResource {
  /**
   * Constructs a new RAG instance.
   * @param config - Configuration object.
   * @param config.embeddingFunction - The embedding function that takes text and returns embeddings.
   * @param config.dbAdapter - The database adapter instance.
   * @param config.llm - Optional LLM adapter for inference.
   * @param config.chunker - Optional chunker instance.
   * @param config.chunkOpts - Optional chunking options for chunking.
   * @param config.logger - Optional logger instance
   */
  constructor(config: {
    embeddingFunction: EmbeddingFunction;
    dbAdapter: BaseDBAdapter;
    llm?: BaseLlmAdapter;
    chunker?: BaseChunkAdapter;
    chunkOpts?: BaseChunkOpts;
    logger?: Logger;
  });

  /**
   * Ready the RAG instance.
   * @returns A promise that resolves when the RAG instance is ready.
   */
  ready(): Promise<void>;

  /**
   * Close the RAG instance.
   * @returns A promise that resolves when the RAG instance is closed.
   */
  close(): Promise<void>;

  /**
   * Generate embeddings for a single text.
   * @param text - The text to generate embeddings for.
   * @returns The embeddings.
   */
  generateEmbeddings(text: string): Promise<number[]>;

  /**
   * Generate embeddings for a set of documents.
   * @param docs - The documents to generate embeddings for.
   * @param opts - Options for embedding generation.
   * @returns A map of document IDs to their embeddings.
   */
  generateEmbeddingsForDocs(
    docs: string | string[],
    opts?: GenerateEmbeddingsOpts
  ): Promise<{ [key: string]: number[] }>;

  /**
   * Save embedded documents directly to the vector database.
   * Documents must have id, content, embedding, and embeddingModelId fields.
   * @param embeddedDocs - Documents with embeddings.
   * @param opts - Options for saving.
   * @returns Array of processing results.
   */
  saveEmbeddings(
    embeddedDocs: EmbeddedDoc[],
    opts?: SaveEmbeddingsOpts
  ): Promise<SaveEmbeddingsResult[]>;

  /**
   * Ingest documents: chunk, embed, and save to the vector database.
   * Convenience method that handles the full pipeline.
   * @param docs - Documents to ingest (text or Doc objects without embeddings).
   * @param embeddingModelId - The embedding model identifier.
   * @param opts - Options for the ingestion pipeline.
   * @returns Processing results and dropped indices.
   */
  ingest(
    docs: string | string[],
    embeddingModelId: string,
    opts?: IngestOpts
  ): Promise<IngestResult>;

  /**
   * Delete embeddings for a set of documents inside the vector database.
   * @param ids - The ids of the documents to be deleted.
   * @returns True if the embeddings were deleted
   */
  deleteEmbeddings(ids: string[]): Promise<boolean>;

  /**
   * Chunks a large text into multiple chunks using the configured chunking options.
   * @param input - The text or array of texts to chunk.
   * @param chunkOpts - Optional chunking options to override the default.
   * @returns Array of chunk results.
   */
  chunk(input: string | string[], chunkOpts?: BaseChunkOpts): Promise<Doc[]>;

  /**
   * Searches for context based on the prompt and generates a response.
   * @param query - The user query.
   * @param opts - Options for inference.
   * @returns The generated response (format depends on LLM adapter) or null if no context found.
   */
  infer(query: string, opts?: InferOpts): Promise<any>;

  /**
   * Searches for documents based on a query string.
   * @param query - The search query.
   * @param params - The parameters for the search.
   * @returns An array of search results.
   */
  search(query: string, params?: SearchParams): Promise<SearchResult[]>;

  /**
   * Reindex the database to optimize search performance.
   * @param opts - Options for reindexing.
   * @returns Reindexing result.
   */
  reindex(opts?: ReindexOpts): Promise<ReindexResult>;

  /**
   * Get stored database adapter configuration.
   * @returns The stored config or null if not configured
   */
  getDBConfig(): Promise<BaseDBAdapterConfig | null>;

  /**
   * Sets the default LLM adapter for the RAG.
   * @param llmAdapter - The LLM adapter.
   */
  setLlm(llmAdapter: BaseLlmAdapter): void;
}

/**
 * HyperDB-based database adapter for vector storage.
 */
declare class HyperDBAdapter extends BaseDBAdapter {
  /**
   * @param config - Configuration object
   * @param config.store - An existing Corestore instance. Required when not providing a db instance
   * @param config.db - An existing HyperDB instance to use instead of creating a new one
   * @param config.dbName - The name of the underlying hypercore
   * @param config.NUM_CENTROIDS - The number of centroids to use for the IVF index
   * @param config.BUCKET_SIZE - The size of the bucket for the IVF index
   * @param config.BATCH_SIZE - The batch size for ingesting documents
   * @param config.CACHE_SIZE - The cache size for the document and vector caches
   * @param config.documentsTable - The name of the documents table
   * @param config.vectorsTable - The name of the vectors table
   * @param config.centroidsTable - The name of the centroids table
   * @param config.invertedIndexTable - The name of the inverted index table
   * @param config.configTable - The name of the config table
   */
  constructor(config?: {
    store?: any;
    db?: any;
    dbName?: string;
    NUM_CENTROIDS?: number;
    BUCKET_SIZE?: number;
    BATCH_SIZE?: number;
    PROGRESS_INTERVAL?: number;
    CACHE_SIZE?: number;
    documentsTable?: string;
    vectorsTable?: string;
    centroidsTable?: string;
    invertedIndexTable?: string;
    configTable?: string;
  });

  /**
   * Get the hypercore instance.
   */
  get core(): any;

  /**
   * Replicate the hypercore with another hypercore.
   * @param otherHypercore - The other hypercore to replicate with
   * @returns An object containing the two streams and a destroy function
   */
  replicateWith(otherHypercore: any): Promise<{
    stream1: any;
    stream2: any;
    destroy: () => void;
  }>;

  /**
   * Save embeddings for a set of documents inside the vector database.
   * @param embeddedDocs - Documents with embeddings to be processed.
   * @param opts - Options for the processing.
   * @returns Array of processing results.
   */
  saveEmbeddings(
    embeddedDocs: EmbeddedDoc[],
    opts?: SaveEmbeddingsOpts
  ): Promise<SaveEmbeddingsResult[]>;

  /**
   * Delete embeddings for a set of documents inside the vector database.
   * @param ids - The ids of the documents to be deleted.
   * @returns True if the embeddings were deleted
   */
  deleteEmbeddings(ids: string[]): Promise<boolean>;

  /**
   * Searches for documents based on a query string.
   * @param query - The search query.
   * @param queryVector - The query vector for similarity search.
   * @param params - The parameters for the search.
   * @returns An array of search results.
   */
  search(
    query: string,
    queryVector: number[],
    params?: SearchParams
  ): Promise<SearchResult[]>;

  /**
   * Reindex the database to optimize search performance.
   * @param opts - Options for reindexing.
   * @returns Reindexing result.
   */
  reindex(opts?: ReindexOpts): Promise<ReindexResult>;

  /**
   * Get stored adapter configuration.
   * @returns The stored config or null if not configured
   */
  getConfig(): Promise<HyperDBAdapterConfig | null>;
}

/**
 * LLM-based chunking adapter using llm-splitter.
 */
declare class LLMChunkAdapter extends BaseChunkAdapter {
  /**
   * @param chunkOpts - Chunking options
   */
  constructor(chunkOpts?: LLMChunkOpts);

  /**
   * Splits text into multiple chunks using LLM-aware strategies.
   * @param input - The text to chunk.
   * @param opts - The options for the chunking.
   * @returns An array of chunk results.
   */
  chunkText(input: string | string[], opts?: LLMChunkOpts): Promise<Doc[]>;
}

/**
 * Custom error class for QVAC RAG library
 * Extends QvacErrorBase for consistent error handling
 */
export declare class QvacErrorRAG extends QvacErrorBase {}

/**
 * Error codes used throughout the QVAC RAG library
 */
export declare const ERR_CODES: Readonly<{
  ABSTRACT_CLASS: 14001;
  DB_ADAPTER_NOT_INITIALIZED: 14002;
  DB_ADAPTER_REQUIRED: 14003;
  CENTROIDS_INITIALIZATION_FAILURE: 14004;
  LLM_REQUIRED: 14005;
  EMBEDDING_FUNCTION_REQUIRED: 14006;
  NOT_IMPLEMENTED: 14007;
  INVALID_INPUT: 14008;
  INVALID_PARAMS: 14009;
  DUPLICATE_DOCUMENT_ID: 14010;
  GENERATION_FAILED: 14011;
  CHUNKING_FAILED: 14012;
  INVALID_CHUNKER: 14013;
  DB_OPERATION_FAILED: 14014;
  DEPENDENCY_REQUIRED: 14015;
  OPERATION_CANCELLED: 14016;
  EMBEDDING_MODEL_MISMATCH: 14017;
  EMBEDDING_DIMENSION_MISMATCH: 14018;
}>;

export {
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
};
