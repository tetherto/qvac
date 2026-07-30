import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt
} from '@ai-sdk/provider'
import {
  createBinaryResponseHandler,
  createStatusCodeErrorResponseHandler,
  getFromApi,
  resolveProviderReference
} from '@ai-sdk/provider-utils'

import { mergeHeaders } from './headers.js'

interface ResolveOptions {
  readonly baseURL: string
  readonly headers: Record<string, string>
  readonly fetch?: typeof fetch
}

async function resolvePrompt(
  prompt: LanguageModelV4Prompt,
  options: ResolveOptions,
  signal?: AbortSignal,
  headers?: Record<string, string | undefined>
): Promise<LanguageModelV4Prompt> {
  const failedResponseHandler = createStatusCodeErrorResponseHandler()
  const successfulResponseHandler = createBinaryResponseHandler()
  return await Promise.all(
    prompt.map(async (message) => {
      if (message.role === 'system' || message.role === 'tool') return message
      const content = await Promise.all(
        message.content.map(async (part) => {
          if (part.type !== 'file' || part.data.type !== 'reference') return part
          const id = resolveProviderReference({ reference: part.data.reference, provider: 'qvac' })
          const response = await getFromApi({
            url: `${options.baseURL.replace(/\/+$/, '')}/files/${encodeURIComponent(id)}/content`,
            headers: mergeHeaders(options.headers, headers),
            failedResponseHandler,
            successfulResponseHandler,
            ...(signal !== undefined && { abortSignal: signal }),
            ...(options.fetch !== undefined && { fetch: options.fetch }),
            validateUrl: false
          })
          return {
            ...part,
            data: { type: 'data' as const, data: response.value }
          }
        })
      )
      return { ...message, content } as typeof message
    })
  )
}

/** Resolve QVAC provider references locally before the OpenAI-compatible wire conversion. */
export function withQvacFileReferences(
  model: LanguageModelV4,
  options: ResolveOptions
): LanguageModelV4 {
  const prepare = async (
    call: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4CallOptions> => ({
    ...call,
    prompt: await resolvePrompt(call.prompt, options, call.abortSignal, call.headers)
  })
  return {
    specificationVersion: 'v4',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: async (call) => model.doGenerate(await prepare(call)),
    doStream: async (call) => model.doStream(await prepare(call))
  }
}
