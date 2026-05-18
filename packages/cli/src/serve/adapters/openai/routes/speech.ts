import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendError } from '../../../http.js'
import { resolveModelAlias } from '../../../config.js'
import { sdkTextToSpeech } from '../../../core/sdk.js'
import {
  buildWavBuffer,
  int16SamplesToBuffer,
  mapResponseFormat,
  pcmContentType,
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

  const maxInputChars = ctx.serveConfig.openai.audio.speech.maxInputChars
  if (maxInputChars !== null && input.length > maxInputChars) {
    sendError(
      res,
      400,
      'input_too_long',
      `"input" exceeds the configured limit of ${maxInputChars} characters (got ${input.length}). ` +
      'Raise serve.openai.audio.speech.maxInputChars or split the request.'
    )
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

  const ignoredParams: string[] = []
  for (const key of IGNORED_PARAMS) {
    if (body[key] !== undefined) {
      ignoredParams.push(key)
      ctx.logger.warn(`Ignoring unsupported param: ${key}=${stringifyForLog(body[key])}`)
    }
  }

  const aliasKey = speechAliasKey(modelName, voice)
  const voiceKey = voice.toLowerCase()
  const voiceMapAlias = ctx.serveConfig.openai.audio.speech.voices?.[voiceKey] ?? null

  let modelEntry: ResolvedModelEntry | ModelEntry | null = null
  let resolvedAlias = ''
  let matchMode: 'voice_map' | 'hyphen' | 'model' = 'model'

  if (typeof voiceMapAlias === 'string' && voiceMapAlias.trim().length > 0) {
    const mapped = voiceMapAlias.trim()
    modelEntry = resolveModelAlias(ctx.serveConfig, mapped)
    if (modelEntry) {
      resolvedAlias = mapped
      matchMode = 'voice_map'
    }
  }

  if (!modelEntry) {
    modelEntry = resolveModelAlias(ctx.serveConfig, aliasKey)
    if (modelEntry) {
      resolvedAlias = aliasKey
      matchMode = 'hyphen'
    }
  }

  if (!modelEntry) {
    modelEntry = resolveModelAlias(ctx.serveConfig, modelName) ?? ctx.registry.getEntry(modelName)
    if (modelEntry) {
      resolvedAlias = modelName
      matchMode = 'model'
    }
  }

  if (!modelEntry) {
    sendError(
      res,
      404,
      'model_not_found',
      `Model "${modelName}" with voice "${voice}" is not available. Add a "${aliasKey}" alias, a "${modelName}" alias, or map this voice under serve.openai.audio.speech.voices to a model alias.`
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
    `  speech model=${alias} voice=${voice} format=${formatMapping.format} chars=${charCount} route=${matchMode} resolved_alias=${resolvedAlias}`
  )

  try {
    // TODO(QVAC-18181): wire client disconnect → cancel SDK call. Currently
    // this awaits to completion even if the HTTP client closed the socket.
    const { samples } = await sdkTextToSpeech({ modelId: sdkModelId, text: input })

    if (samples.length === 0) {
      ctx.logger.warn(`  speech empty model=${alias} voice=${voice} chars=${charCount}`)
      sendError(res, 502, 'speech_empty', 'Speech synthesis returned no audio samples.')
      return
    }

    const audioBytes = formatMapping.format === 'wav'
      ? buildWavBuffer(samples, sampleRate)
      : int16SamplesToBuffer(samples)
    const contentType = formatMapping.format === 'pcm'
      ? pcmContentType(sampleRate)
      : formatMapping.contentType

    ctx.logger.info(`  speech done samples=${samples.length} bytes=${audioBytes.length} sample_rate=${sampleRate}`)

    if (res.headersSent) return
    const headers: Record<string, string | number> = {
      'Content-Type': contentType,
      'Content-Length': audioBytes.length,
      'X-Audio-Sample-Rate': String(sampleRate),
      'X-Audio-Channels': '1',
      'X-Audio-Bits-Per-Sample': '16'
    }
    if (ignoredParams.length > 0) {
      // Surface dropped OpenAI params to clients without making them grep logs.
      headers['X-QVAC-Ignored-Params'] = ignoredParams.join(',')
    }
    res.writeHead(200, headers)
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
