import { BaseLlmAdapter } from './BaseLlmAdapter.js'
import { QvacErrorRAG, ERR_CODES } from '../../errors.js'
import resolveFetch from '../../shims/resolve-fetch.js'
import type { InferOpts, SearchResult } from '../../types.js'

export interface HttpConfig {
  apiUrl: string
  method?: string
  headers?: Record<string, string>
}

type RequestBodyFormatter = (query: string, searchResults: SearchResult[], opts?: object) => object
type ResponseBodyFormatter = (response: unknown) => unknown

// The subset of a fetch Response this adapter relies on.
interface FetchResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}

// HTTP-based LLM adapter that can work with various HTTP LLM APIs. Requires a
// fetch implementation (bare-fetch on Bare, global fetch elsewhere).
export class HttpLlmAdapter extends BaseLlmAdapter {
  httpConfig: HttpConfig & { method: string; headers: Record<string, string> }
  requestBodyFormatter: RequestBodyFormatter
  responseBodyFormatter: ResponseBodyFormatter

  constructor(
    httpConfig: HttpConfig,
    requestBodyFormatter: RequestBodyFormatter,
    responseBodyFormatter: ResponseBodyFormatter
  ) {
    super()

    if (!httpConfig || typeof httpConfig !== 'object') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'HTTP configuration is required'
      })
    }

    if (!httpConfig.apiUrl || typeof httpConfig.apiUrl !== 'string') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'API URL is required and must be a string'
      })
    }

    if (!requestBodyFormatter || typeof requestBodyFormatter !== 'function') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'Request body formatter function is required'
      })
    }

    if (!responseBodyFormatter || typeof responseBodyFormatter !== 'function') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'Response body formatter function is required'
      })
    }

    this.httpConfig = {
      method: 'POST',
      ...httpConfig,
      headers: {
        'Content-Type': 'application/json',
        ...httpConfig.headers
      }
    }
    this.requestBodyFormatter = requestBodyFormatter
    this.responseBodyFormatter = responseBodyFormatter
  }

  override async run(
    query: string,
    searchResults: SearchResult[],
    opts: InferOpts = {}
  ): Promise<unknown> {
    try {
      const requestBody = this.requestBodyFormatter(query, searchResults, opts)
      if (!requestBody || typeof requestBody !== 'object') {
        throw new QvacErrorRAG({
          code: ERR_CODES.INVALID_INPUT,
          adds: 'Request body formatter must return an object'
        })
      }
      const response = await this._makeHttpRequest(requestBody)
      return this.responseBodyFormatter(response)
    } catch (error) {
      if (error instanceof QvacErrorRAG) {
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new QvacErrorRAG({
        code: ERR_CODES.GENERATION_FAILED,
        adds: `HTTP LLM request failed: ${message}`,
        cause: error instanceof Error ? error : undefined
      })
    }
  }

  private async _makeHttpRequest(requestBody: object): Promise<unknown> {
    const fetch = await resolveFetch()

    const response = (await fetch(this.httpConfig.apiUrl, {
      method: this.httpConfig.method,
      headers: this.httpConfig.headers,
      body: JSON.stringify(requestBody)
    })) as FetchResponse

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return response.json()
  }

  updateHttpConfig(newHttpConfig: Partial<HttpConfig>): void {
    this.httpConfig = { ...this.httpConfig, ...newHttpConfig }
  }

  updateRequestBodyFormatter(newFormatter: RequestBodyFormatter): void {
    if (typeof newFormatter !== 'function') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'Request body formatter must be a function'
      })
    }
    this.requestBodyFormatter = newFormatter
  }

  updateResponseBodyFormatter(newFormatter: ResponseBodyFormatter): void {
    if (typeof newFormatter !== 'function') {
      throw new QvacErrorRAG({
        code: ERR_CODES.INVALID_INPUT,
        adds: 'Response body formatter must be a function'
      })
    }
    this.responseBodyFormatter = newFormatter
  }
}
