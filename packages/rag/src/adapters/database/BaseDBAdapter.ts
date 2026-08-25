import ReadyResource from 'ready-resource'
import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import type {
  BaseDBAdapterConfig,
  DbOpts,
  EmbeddedDoc,
  ReindexOpts,
  ReindexResult,
  SaveEmbeddingsResult,
  SearchParams,
  SearchResult
} from '../../types.js'

// Abstract base class for vector database adapters.
export abstract class BaseDBAdapter extends ReadyResource {
  isInitialized: boolean

  // lunte-disable-next-line no-unused-vars
  constructor(config: Record<string, unknown> = {}) {
    super()
    if (new.target === BaseDBAdapter) {
      throw new QvacErrorRAG({ code: ERR_CODES.ABSTRACT_CLASS })
    }
    this.isInitialized = false
  }

  // Save embeddings for a set of documents. Subclasses must override.
  // lunte-disable-next-line no-unused-vars,require-await
  async saveEmbeddings(docs: EmbeddedDoc[], opts?: DbOpts): Promise<SaveEmbeddingsResult[]> {
    throw new QvacErrorRAG({ code: ERR_CODES.NOT_IMPLEMENTED })
  }

  // Delete embeddings by id. Subclasses must override.
  // lunte-disable-next-line no-unused-vars,require-await
  async deleteEmbeddings(ids: string[]): Promise<boolean> {
    throw new QvacErrorRAG({ code: ERR_CODES.NOT_IMPLEMENTED })
  }

  // Search for documents given a text query and its vector. Subclasses must override.
  // lunte-disable-next-line no-unused-vars,require-await
  async search(
    query: string,
    queryVector: number[],
    params?: SearchParams
  ): Promise<SearchResult[]> {
    throw new QvacErrorRAG({ code: ERR_CODES.NOT_IMPLEMENTED })
  }

  // Reindex the database. Default implementation reports no reindex; adapters may override.
  // lunte-disable-next-line no-unused-vars,require-await
  async reindex(opts?: ReindexOpts): Promise<ReindexResult> {
    return { reindexed: false, details: {} }
  }

  // Get the stored adapter configuration. Subclasses must override.
  // lunte-disable-next-line require-await
  async getConfig(): Promise<BaseDBAdapterConfig | null> {
    throw new QvacErrorRAG({ code: ERR_CODES.NOT_IMPLEMENTED })
  }
}
