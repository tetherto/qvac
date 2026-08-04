import type { FilesV4, FilesV4UploadFileCallOptions } from '@ai-sdk/provider'
import {
  createStatusCodeErrorResponseHandler,
  postFormDataToApi,
  type ResponseHandler
} from '@ai-sdk/provider-utils'

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

function bytesFor(data: FilesV4UploadFileCallOptions['data']): Uint8Array {
  if (data.type === 'text') return new TextEncoder().encode(data.text)
  if (typeof data.data === 'string') return Uint8Array.from(Buffer.from(data.data, 'base64'))
  return data.data
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
    async uploadFile({ data, mediaType, filename, providerOptions }) {
      const form = new FormData()
      const bytes = bytesFor(data)
      const body = bytes.slice().buffer as ArrayBuffer
      form.append('file', new Blob([body], { type: mediaType }), filename ?? 'upload.bin')
      const purpose = providerOptions?.['qvac']?.['purpose']
      if (typeof purpose === 'string' && purpose.length > 0) form.append('purpose', purpose)

      const response = await postFormDataToApi({
        url: `${options.baseURL.replace(/\/+$/, '')}/files`,
        headers: multipartHeaders(options.headers),
        formData: form,
        failedResponseHandler,
        successfulResponseHandler,
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
