import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  RequestRejectedByPolicyError,
  RequestValidationFailedError,
  SDK_SERVER_ERROR_CODES,
  bciTranscribe,
  bciTranscribeStream,
  type TranscribeSegment
} from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { multipartToBodyOptional } from '@/serve/lib/multipart'
import { resolveBinaryInput } from '@/serve/lib/binary-input'
import { ADMIN_REFUSED, errorResponses } from '@/serve/lib/error-responses'
import { endSSE, initSSE, sendSSE } from '@/serve/lib/sse'
import { formatTimedTranscription } from '@/serve/lib/transcription-response'
import { requireModel } from '@/serve/core/plugins/require-model'
import { bindClientDisconnectCancel } from '@/serve/core/cancel-bridge'
import { defaultState } from '@/serve/extensions/default/state'
import {
  bciTranscriptionsBody,
  BCI_MAX_BATCH_TIMESTEPS,
  neuralDataProblem,
  neuralDurationMs,
  type BciTranscriptionsBody
} from '@/serve/extensions/default/schemas/bci'

const TAG = 'BCI'
const TRANSCRIPTIONS = '/qvac/v1/bci/transcriptions'

// `@qvac/bci-whispercpp` error codes, which reach the client on the SDK error.
const ADDON_INVALID_NEURAL_INPUT = 26006
const ADDON_JOB_ALREADY_RUNNING = 26007
const ADDON_BUFFER_LIMIT_EXCEEDED = 26010
const ADDON_STREAM_ALREADY_ACTIVE = 26014

const STREAM_CHUNK_BYTES = 64 * 1024

const description = `
**Experimental**: the request and response shapes may change.

Admin-only: answers \`403 admin_disabled\` unless the server was started with
\`--enable-admin\`. The model's native reader does not yet check a recording's channel
count against the model, so a mismatched recording can crash the worker.

Transcribe a neural-signal recording with a BCI model, backed by the SDK's
\`bciTranscribe()\`, or \`bciTranscribeStream()\` with \`stream: true\`. \`model\` names a
\`serve.models\` alias whose endpoint category is \`bci\`. The request and response follow
\`/v1/audio/transcriptions\`.

Send JSON or \`multipart/form-data\`. \`file\` is the recording: a little-endian
\`[timesteps u32, channels u32]\` header, then \`timesteps * channels\` float32 samples, one
timestep per 20 ms. It is a multipart file part, a base64 data URL, or the \`id\` of a file
uploaded with \`POST /v1/files\`. Without \`stream\`, the recording must fit one decode
(at most ${BCI_MAX_BATCH_TIMESTEPS} timesteps); send a longer one with \`stream: true\`.

\`response_format\` is \`json\` (default, \`{ "text" }\`), \`text\`, \`verbose_json\`, \`srt\`
or \`vtt\`. The timed formats report the recording's real length as \`duration\`, and no
segment ends after it.

With \`stream: true\` the recording is decoded in sliding windows of \`window_timesteps\`
(default 1500, at most 2900), advancing by \`hop_timesteps\` (default 500, below the
window), and the response is server-sent events: one \`transcript.text.delta\` event per
window that found new text, then \`transcript.text.done\` with the deltas joined by spaces,
then \`[DONE]\`. A failure after the first event ends the stream with an \`error\` event and
no \`[DONE]\`.

A client disconnect cancels the transcription.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    TRANSCRIPTIONS,
    {
      config: { admin: true },
      schema: {
        body: bciTranscriptionsBody,
        response: {
          ...errorResponses({
            400: {
              invalid_json: 'Body is not valid JSON',
              invalid_multipart: 'The multipart body cannot be parsed',
              missing_model: '`model` is missing',
              missing_file: '`file` is missing',
              empty_input: '`file` has no bytes',
              invalid_data_url: '`file` is a data URL that is not base64',
              file_not_found: '`file` is neither a data URL nor an uploaded file id',
              invalid_neural_data:
                '`file` is not a neural recording: a short header, zero channels or timesteps, a length the header does not match, or the model refused it',
              neural_data_too_large:
                "`file` is over the model's input buffer, or a batch recording is over 3000 timesteps",
              invalid_response_format:
                '`response_format` is not one of `json`, `text`, `verbose_json`, `srt`, `vtt`, or a stream asked for a timed format',
              invalid_window:
                '`window_timesteps` or `hop_timesteps` is not a positive integer, is sent without `stream`, the window is over 2900, or the hop is not below the window (an omitted side defaults to 1500 and 500)',
              invalid_request: 'The body carries an unknown field',
              invalid_model_type: 'The alias is not a `bci` model'
            },
            403: ADMIN_REFUSED,
            404: { model_not_found: 'Unknown alias' },
            413: { request_too_large: 'The upload is over the size cap' },
            429: {
              request_rejected_by_policy: 'More than 64 requests are already waiting for the model'
            },
            503: {
              model_not_loaded: 'The model is not loaded and lazy loading is disabled',
              model_load_failed: 'The model failed to load',
              model_load_timeout: 'The model did not load in time'
            }
          })
        },
        tags: [TAG],
        summary: 'Transcribe a neural recording (experimental)',
        description,
        consumes: ['application/json', 'multipart/form-data'],
        produces: ['application/json', 'text/plain', 'text/vtt', 'text/event-stream']
      },
      preValidation: multipartToBodyOptional,
      preHandler: [
        // lunte-disable-next-line require-await
        async function (req) {
          const { bytes } = resolveBinaryInput(req, 'file', req.body.file)
          const problem = neuralDataProblem(bytes, req.body.stream === true)
          if (problem !== null) throw new HttpError(400, problem.code, problem.message)
          req.bciNeuralData = bytes
        },
        requireModel('bci')
      ]
    },
    async (req, reply) => {
      const { sdkModelId, alias } = req.qvacModel!
      const bytes = req.bciNeuralData!
      const format = req.body.response_format ?? 'json'
      app.qvac.logger.info(
        `  bci_transcribe model=${alias} bytes=${bytes.length} format=${format} stream=${req.body.stream === true}`
      )

      if (req.body.stream === true) {
        await streamTranscription(req, reply, req.body, sdkModelId, bytes)
        return reply
      }

      const state = defaultState(app.qvac)
      const transcribe = state.bciTranscribeOverride ?? bciTranscribe
      const neuralData = new Uint8Array(bytes)
      const timed = format !== 'json' && format !== 'text'

      const run = callSdk(() =>
        timed
          ? transcribe({ modelId: sdkModelId, neuralData, metadata: true })
          : transcribe({ modelId: sdkModelId, neuralData })
      )
      bindClientDisconnectCancel(reply.raw, run.requestId, app.qvac.logger, state.cancelOverride)
      const result: string | TranscribeSegment[] = await run.catch(rethrow)

      if (typeof result === 'string') {
        app.qvac.logger.info(`  bci_transcribe done chars=${result.length}`)
        if (format === 'text') {
          return reply.type('text/plain; charset=utf-8').send(result)
        }
        return { text: result }
      }

      const response = formatTimedTranscription(format as 'verbose_json' | 'srt' | 'vtt', result, {
        durationMs: neuralDurationMs(bytes)
      })
      app.qvac.logger.info(`  bci_transcribe done segments=${result.length}`)
      return reply.type(response.contentType).send(response.body)
    }
  )
}

async function streamTranscription(
  req: FastifyRequest,
  reply: FastifyReply,
  body: BciTranscriptionsBody,
  modelId: string,
  bytes: Buffer
): Promise<void> {
  const { qvac } = req.server
  const state = defaultState(qvac)
  const { window_timesteps: windowTimesteps, hop_timesteps: hopTimesteps } = body

  const session = await callSdk(() =>
    (state.bciTranscribeStreamOverride ?? bciTranscribeStream)({
      modelId,
      emit: 'delta',
      ...(windowTimesteps !== undefined ? { windowTimesteps } : {}),
      ...(hopTimesteps !== undefined ? { hopTimesteps } : {})
    })
  ).catch(rethrow)
  // A disconnect only cancels, and the run's stream is drained. Destroying the
  // session on top of the cancel crashed the worker.
  bindClientDisconnectCancel(reply.raw, session.requestId, qvac.logger, state.cancelOverride)
  const raw = reply.raw
  let closed = false
  raw.once('close', () => {
    closed = !raw.writableEnded
  })
  const clientGone = () => closed || raw.destroyed

  for (let offset = 0; offset < bytes.length; offset += STREAM_CHUNK_BYTES) {
    session.write(new Uint8Array(bytes.subarray(offset, offset + STREAM_CHUNK_BYTES)))
  }
  session.end()

  const deltas = session[Symbol.asyncIterator]()
  // Waiting for the first window before opening the stream lets a failure
  // there come back as a JSON error.
  const first = await deltas.next().catch(rethrow)

  if (clientGone()) {
    await drain(deltas)
    return
  }
  initSSE(reply)
  const texts: string[] = []

  // Fastify drops errors thrown after hijack, so a failure here has to end
  // the stream itself or the client would hang.
  try {
    for (let next = first; next.done !== true; next = await deltas.next()) {
      // The cancelled run still ends its stream; drain it without writing.
      if (clientGone()) continue
      texts.push(next.value.trim())
      sendSSE(raw, { type: 'transcript.text.delta', delta: next.value })
    }
  } catch (err) {
    if (clientGone()) return
    const message = err instanceof Error ? err.message : String(err)
    qvac.logger.error(`  bci_transcribe stream failed: ${message}`)
    sendSSE(raw, {
      error: { message: 'BCI transcription failed.', type: 'server_error', code: 'internal_error' }
    })
    endSSE(raw, { sentinel: false })
    return
  }
  if (clientGone()) return
  // The addon trims each delta, so joining them as-is glues the windows' words.
  const text = texts.filter((delta) => delta.length > 0).join(' ')
  sendSSE(raw, { type: 'transcript.text.done', text })
  qvac.logger.info(`  bci_transcribe stream done chars=${text.length}`)
  endSSE(raw)
}

async function drain(deltas: AsyncIterator<unknown>): Promise<void> {
  try {
    while ((await deltas.next()).done !== true);
  } catch {
    // The cancel fails the run; there is no client left to tell.
  }
}

// Client-side validation throws synchronously; the worker's arrives on the result.
function callSdk<T>(call: () => T): T {
  try {
    return call()
  } catch (err) {
    return rethrow(err)
  }
}

function rethrow(thrown: unknown): never {
  const err = streamedCause(thrown)
  if (err instanceof RequestRejectedByPolicyError) throw err
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof RequestValidationFailedError || code === ADDON_INVALID_NEURAL_INPUT) {
    throw new HttpError(400, 'invalid_neural_data', message)
  }
  if (code === ADDON_BUFFER_LIMIT_EXCEEDED) {
    throw new HttpError(400, 'neural_data_too_large', message)
  }
  if (code === ADDON_JOB_ALREADY_RUNNING || code === ADDON_STREAM_ALREADY_ACTIVE) {
    throw new HttpError(429, 'request_rejected_by_policy', message)
  }
  throw thrown
}

// A stream's worker error arrives wrapped in the SDK's transcription error,
// with the original (and its code) as `cause`.
function streamedCause(err: unknown): unknown {
  const { code, cause } = (err ?? {}) as { code?: unknown; cause?: unknown }
  return code === SDK_SERVER_ERROR_CODES.TRANSCRIPTION_FAILED && cause instanceof Error
    ? cause
    : err
}

declare module 'fastify' {
  interface FastifyRequest {
    bciNeuralData?: Buffer
  }
}

export default plugin
