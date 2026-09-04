import {
  UnsupportedFunctionalityError,
  type FilesV4,
  type FilesV4UploadFileCallOptions
} from '@ai-sdk/provider'
import {
  createStatusCodeErrorResponseHandler,
  postFormDataToApi,
  type ResponseHandler
} from '@ai-sdk/provider-utils'

import { mergeHeaders } from './headers.js'

export interface QvacFilesOptions {
  readonly baseURL: string
  readonly headers: Record<string, string>
  readonly fetch?: typeof fetch
}

function multipartHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type')
  )
}

/**
 * A `stream` input is drained into bytes instead of being forwarded as a
 * streaming request body: `POST /v1/files` buffers the whole upload into
 * serve's in-memory ephemeral store, so streaming the request would add a
 * `duplex: 'half'` requirement on the caller's `fetch` without any consumer
 * on the other end.
 *
 * The `default` branch keeps a future `@ai-sdk/provider` data variant a
 * runtime error for the one unsupported call rather than a build failure for
 * the whole package.
 */
async function bytesFor(data: FilesV4UploadFileCallOptions['data']): Promise<Uint8Array> {
  switch (data.type) {
    case 'text':
      return new TextEncoder().encode(data.text)
    case 'data':
      return typeof data.data === 'string'
        ? Uint8Array.from(Buffer.from(data.data, 'base64'))
        : data.data
    case 'stream':
      return new Uint8Array(await new Response(data.stream).arrayBuffer())
    default:
      throw new UnsupportedFunctionalityError({
        functionality: `file upload data type '${(data as { type: string }).type}'`
      })
  }
}

/** AI SDK v4 files interface backed by QVAC serve's local ephemeral file store. */
export function createQvacFiles(options: QvacFilesOptions): FilesV4 {
  const failedResponseHandler = createStatusCodeErrorResponseHandler()
  const successfulResponseHandler: ResponseHandler<{ id?: string; filename?: string }> = async ({
    response
  }) => {
    const result = (await response.json()) as { id?: string; filename?: string }
    const responseHeaders = Object.fromEntries(response.headers.entries())
    return { value: result, rawValue: result, responseHeaders }
  }
  return {
    specificationVersion: 'v4',
    provider: 'qvac',
    async uploadFile({ data, mediaType, filename, providerOptions, abortSignal, headers }) {
      const form = new FormData()
      const bytes = await bytesFor(data)
      const body = bytes.slice().buffer as ArrayBuffer
      form.append('file', new Blob([body], { type: mediaType }), filename ?? 'upload.bin')
      const purpose = providerOptions?.['qvac']?.['purpose']
      if (typeof purpose === 'string' && purpose.length > 0) form.append('purpose', purpose)

      const response = await postFormDataToApi({
        url: `${options.baseURL.replace(/\/+$/, '')}/files`,
        headers: multipartHeaders(mergeHeaders(options.headers, headers)),
        formData: form,
        failedResponseHandler,
        successfulResponseHandler,
        ...(abortSignal !== undefined && { abortSignal }),
        ...(options.fetch !== undefined && { fetch: options.fetch })
      })
      const result = response.value
      if (!result.id) throw new Error('QVAC file upload returned no file id')
      const resolvedFilename = result.filename ?? filename
      return {
        providerReference: { qvac: result.id },
        mediaType,
        ...(resolvedFilename !== undefined && { filename: resolvedFilename }),
        providerMetadata: { qvac: { ephemeral: true } },
        warnings: []
      }
    }
  }
}
