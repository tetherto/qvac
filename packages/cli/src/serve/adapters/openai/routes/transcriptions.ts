import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendText, sendError } from '../../../http.js'
import { readMultipart } from '../../../multipart.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkTranscribe } from '../../../core/sdk.js'
import type { RouteContext } from '../../types.js'

const SUPPORTED_RESPONSE_FORMATS = new Set(['json', 'text'])
const UNSUPPORTED_RESPONSE_FORMATS = new Set(['srt', 'vtt', 'verbose_json'])

export async function handleTranscriptions (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) {
    sendError(res, 400, 'invalid_content_type', 'Content-Type must be multipart/form-data.')
    return
  }

  let fields: Map<string, string>
  let file: { fieldName: string; fileName: string; contentType: string; data: Buffer } | null

  try {
    const result = await readMultipart(req)
    fields = result.fields
    file = result.file
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Multipart parse error: ${message}`)
    sendError(res, 400, 'invalid_multipart', 'Failed to parse multipart request.')
    return
  }

  if (!file || file.fieldName !== 'file') {
    sendError(res, 400, 'missing_file', '"file" field is required.')
    return
  }

  const modelName = fields.get('model')
  if (!modelName) {
    sendError(res, 400, 'missing_model', '"model" field is required.')
    return
  }

  const responseFormat = fields.get('response_format') ?? 'json'
  if (UNSUPPORTED_RESPONSE_FORMATS.has(responseFormat)) {
    sendError(res, 400, 'unsupported_response_format', `response_format "${responseFormat}" is not supported. Use "json" or "text".`)
    return
  }
  if (!SUPPORTED_RESPONSE_FORMATS.has(responseFormat)) {
    sendError(res, 400, 'invalid_response_format', `Unknown response_format "${responseFormat}". Use "json" or "text".`)
    return
  }

  const prompt = fields.get('prompt')
  const language = fields.get('language')
  const temperature = fields.get('temperature')

  const modelEntry = resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)

  if (!modelEntry) {
    sendError(res, 404, 'model_not_found', `Model "${modelName}" is not available. Check serve.models config.`)
    return
  }

  const endpointCategory = 'endpointCategory' in modelEntry ? modelEntry.endpointCategory : undefined
  if (endpointCategory !== 'transcription') {
    sendError(res, 400, 'invalid_model_type', `Model "${modelName}" does not support transcription.`)
    return
  }

  const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
  const registryEntry = ctx.registry.getEntry(alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    sendError(res, 503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
    return
  }

  if (language) {
    ctx.logger.warn(`language="${language}" is configured at model load time. Per-request language override is not yet supported.`)
  }
  if (temperature) {
    ctx.logger.warn(`Ignoring unsupported param: temperature=${temperature}`)
  }

  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
  const fileSizeKB = Math.round(file.data.length / 1024)

  ctx.logger.info(`  transcribe model=${alias} file=${file.fileName} size=${fileSizeKB}KB format=${responseFormat}${prompt ? ' prompt=yes' : ''}`)

  try {
    const text = await sdkTranscribe({
      modelId: sdkModelId,
      audioChunk: file.data,
      fileName: file.fileName,
      prompt
    })

    ctx.logger.info(`  transcribe done chars=${text.length}`)

    if (responseFormat === 'text') {
      sendText(res, 200, text)
    } else {
      sendJson(res, 200, { text })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Transcription error for "${alias}": ${message}`)
    sendError(res, 500, 'transcription_error', 'An internal error occurred during transcription.')
  }
}
