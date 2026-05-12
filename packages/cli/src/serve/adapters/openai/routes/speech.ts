import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendError } from '../../../http.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkTextToSpeech } from '../../../core/sdk.js'
import {
  buildWavBuffer,
  int16SamplesToBuffer,
  mapResponseFormat,
  resolveSampleRate,
  speechAliasKey
} from '../../../audio.js'
import type { ModelEntry, ResolvedModelEntry } from '../../../core/model-registry.js'
import type { RouteContext } from '../../types.js'

const IGNORED_PARAMS = new Set([
  'speed',
  'instructions',
  'stream_format'
])

export async function handleAudioSpeech (req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<void> {
  let body: Record<string, unknown>
  try {
    body = await readBody(req)
  } catch {
    sendError(res, 400, 'invalid_json', 'Request body must be valid JSON.')
    return
  }

  const modelName = typeof body['model'] === 'string' ? body['model'].trim() : ''
  if (!modelName) {
    sendError(res, 400, 'missing_model', '"model" is required.')
    return
  }

  const input = typeof body['input'] === 'string' ? body['input'] : ''
  if (!input.trim()) {
    sendError(res, 400, 'missing_input', '"input" is required and must be a non-empty string.')
    return
  }

  const voice = resolveVoice(body['voice'], ctx.serveConfig.openai.audio.speech.defaultVoice)
  if (voice === null) {
    sendError(res, 400, 'missing_voice', '"voice" is required (no default voice configured).')
    return
  }

  const formatMapping = mapResponseFormat(body['response_format'])
  if (formatMapping.kind === 'unsupported') {
    sendError(res, 400, 'unsupported_response_format', formatMapping.message)
    return
  }
  if (formatMapping.kind === 'invalid') {
    sendError(res, 400, 'invalid_response_format', formatMapping.message)
    return
  }

  for (const key of IGNORED_PARAMS) {
    if (body[key] !== undefined) {
      ctx.logger.warn(`Ignoring unsupported param: ${key}=${stringifyForLog(body[key])}`)
    }
  }

  const aliasKey = speechAliasKey(modelName, voice)
  let modelEntry: ResolvedModelEntry | ModelEntry | null = resolveModelAlias(ctx.serveConfig, aliasKey)
  let resolvedAlias = aliasKey
  if (!modelEntry) {
    modelEntry = resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)
    resolvedAlias = modelName
  }

  if (!modelEntry) {
    sendError(
      res,
      404,
      'model_not_found',
      `Model "${modelName}" with voice "${voice}" is not available. Add either a "${modelName}" alias or a "${aliasKey}" alias under serve.models.`
    )
    return
  }

  const endpointCategory = 'endpointCategory' in modelEntry ? modelEntry.endpointCategory : undefined
  if (endpointCategory !== 'speech') {
    sendError(res, 400, 'invalid_model_type', `Model "${modelName}" does not support speech synthesis.`)
    return
  }

  const alias = 'alias' in modelEntry ? (modelEntry.alias as string) : modelEntry.id
  const registryEntry = ctx.registry.getEntry(alias)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    sendError(res, 503, 'model_not_ready', `Model "${modelName}" is not loaded yet.`)
    return
  }

  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
  const sampleRate = resolveSampleRate(registryEntry.config)
  const charCount = input.length

  ctx.logger.info(
    `  speech model=${alias} voice=${voice} format=${formatMapping.format} chars=${charCount} alias_match=${resolvedAlias === aliasKey ? 'voice' : 'model'}`
  )

  try {
    const { samples } = await sdkTextToSpeech({ modelId: sdkModelId, text: input })

    const audioBytes = formatMapping.format === 'wav'
      ? buildWavBuffer(samples, sampleRate)
      : int16SamplesToBuffer(samples)

    ctx.logger.info(`  speech done samples=${samples.length} bytes=${audioBytes.length} sample_rate=${sampleRate}`)

    if (res.headersSent) return
    res.writeHead(200, {
      'Content-Type': formatMapping.contentType,
      'Content-Length': audioBytes.length,
      'X-Audio-Sample-Rate': String(sampleRate),
      'X-Audio-Channels': '1',
      'X-Audio-Bits-Per-Sample': '16'
    })
    res.end(audioBytes)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error(`Speech synthesis error for "${alias}": ${message}`)
    sendError(res, 500, 'speech_error', 'An internal error occurred during speech synthesis.')
  }
}

function resolveVoice (raw: unknown, fallback: string | null): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.length > 0) return trimmed
  }
  return fallback
}

function stringifyForLog (value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
