import type { SharedV4Warning, SpeechModelV4, TranscriptionModelV4 } from '@ai-sdk/provider'
import {
  createBinaryResponseHandler,
  createStatusCodeErrorResponseHandler,
  postFormDataToApi,
  postJsonToApi,
  type ResponseHandler
} from '@ai-sdk/provider-utils'

interface QvacAudioOptions {
  readonly baseURL: string
  readonly headers: Record<string, string>
  readonly fetch?: typeof fetch
}

function endpoint(options: QvacAudioOptions, path: string): string {
  return `${options.baseURL.replace(/\/+$/, '')}${path}`
}

function requestHeaders(
  configured: Record<string, string>,
  perCall: Record<string, string | undefined> | undefined
): Record<string, string> {
  const headers = { ...configured }
  for (const [name, value] of Object.entries(perCall ?? {})) {
    if (value !== undefined) headers[name] = value
  }
  return headers
}

function withoutContentType(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type')
  )
}

function bytesFor(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? Uint8Array.from(Buffer.from(data, 'base64')) : data
}

interface JsonResponse<T> {
  readonly body: T
  readonly headers: Record<string, string>
}

function jsonResponseHandler<T>(): ResponseHandler<JsonResponse<T>> {
  return async ({ response }) => {
    const body = (await response.json()) as T
    const headers = Object.fromEntries(response.headers.entries())
    return {
      value: { body, headers },
      rawValue: body,
      responseHeaders: headers
    }
  }
}

const binaryResponseHandler = createBinaryResponseHandler()
const binaryWithHeadersHandler: ResponseHandler<{
  audio: Uint8Array
  headers: Record<string, string>
}> = async (options) => {
  const result = await binaryResponseHandler(options)
  return {
    ...result,
    value: { audio: result.value, headers: result.responseHeaders ?? {} }
  }
}

const statusCodeErrorResponseHandler = createStatusCodeErrorResponseHandler()

export function createQvacTranscriptionModel(
  modelId: string,
  options: QvacAudioOptions
): TranscriptionModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'qvac.transcription',
    modelId,
    async doGenerate({ audio, mediaType, providerOptions, abortSignal, headers }) {
      const qvacOptions = providerOptions?.['qvac'] ?? {}
      const form = new FormData()
      const bytes = bytesFor(audio)
      form.append(
        'file',
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: mediaType }),
        'audio-input'
      )
      form.append('model', modelId)
      form.append('response_format', 'json')

      const prompt = qvacOptions['prompt']
      const language = qvacOptions['language']
      const temperature = qvacOptions['temperature']
      if (typeof prompt === 'string') form.append('prompt', prompt)
      if (typeof language === 'string') form.append('language', language)
      if (typeof temperature === 'number') form.append('temperature', String(temperature))

      const warnings: SharedV4Warning[] = []
      if (language !== undefined) {
        warnings.push({
          type: 'unsupported',
          feature: 'providerOptions.qvac.language',
          details: 'QVAC configures transcription language when the model is loaded.'
        })
      }
      if (temperature !== undefined) {
        warnings.push({
          type: 'unsupported',
          feature: 'providerOptions.qvac.temperature',
          details: 'The local transcription runtime does not use per-request temperature.'
        })
      }

      const timestamp = new Date()
      const transcriptionResponse = await postFormDataToApi({
        url: endpoint(options, '/audio/transcriptions'),
        headers: withoutContentType(requestHeaders(options.headers, headers)),
        formData: form,
        failedResponseHandler: statusCodeErrorResponseHandler,
        successfulResponseHandler: jsonResponseHandler<{ text?: unknown }>(),
        ...(abortSignal !== undefined && { abortSignal }),
        ...(options.fetch !== undefined && { fetch: options.fetch })
      })
      const { body, headers: responseHeaders } = transcriptionResponse.value
      if (typeof body.text !== 'string') throw new Error('QVAC transcription returned no text')

      return {
        text: body.text,
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
        warnings,
        response: {
          timestamp,
          modelId,
          headers: responseHeaders,
          body
        },
        providerMetadata: { qvac: { local: true } }
      }
    }
  }
}

export function createQvacSpeechModel(modelId: string, options: QvacAudioOptions): SpeechModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'qvac.speech',
    modelId,
    async doGenerate({
      text,
      voice,
      outputFormat,
      instructions,
      speed,
      language,
      abortSignal,
      headers
    }) {
      const warnings: SharedV4Warning[] = []
      for (const [feature, value] of Object.entries({ instructions, speed, language })) {
        if (value !== undefined) {
          warnings.push({
            type: 'unsupported',
            feature,
            details: `QVAC local speech synthesis does not use per-request ${feature}.`
          })
        }
      }

      const body = {
        model: modelId,
        input: text,
        ...(voice !== undefined && { voice }),
        ...(outputFormat !== undefined && { response_format: outputFormat })
      }
      const timestamp = new Date()
      const speechResponse = await postJsonToApi({
        url: endpoint(options, '/audio/speech'),
        headers: withoutContentType(requestHeaders(options.headers, headers)),
        body,
        failedResponseHandler: statusCodeErrorResponseHandler,
        successfulResponseHandler: binaryWithHeadersHandler,
        ...(abortSignal !== undefined && { abortSignal }),
        ...(options.fetch !== undefined && { fetch: options.fetch })
      })
      const { audio, headers: responseHeaders } = speechResponse.value

      return {
        audio,
        warnings,
        request: { body },
        response: {
          timestamp,
          modelId,
          headers: responseHeaders
        },
        providerMetadata: {
          qvac: {
            local: true,
            mediaType: responseHeaders['content-type'] ?? 'application/octet-stream'
          }
        }
      }
    }
  }
}
