import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  RequestValidationFailedError,
  SDK_SERVER_ERROR_CODES,
  vla,
  vlaHparams,
  vlaPadState,
  vlaPreprocessImage,
  vlaSetEmbodiment,
  type VlaEmbodimentSelection,
  type VlaHparams
} from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { errorResponses } from '@/serve/lib/error-responses'
import { requireModel, resolveAndCheckModel } from '@/serve/core/plugins/require-model'
import { bindClientDisconnectCancel } from '@/serve/core/cancel-bridge'
import { defaultState } from '@/serve/extensions/default/state'
import {
  VLA_FIELD_CODES,
  vlaActions,
  vlaActionsBody,
  vlaEmbodimentBody,
  vlaModel,
  vlaModelParams,
  type VlaActionsBody,
  type VlaImageInput
} from '@/serve/extensions/default/schemas/vla'

const TAG = 'VLA'
const ACTIONS = '/qvac/v1/vla/actions'
const MODELS = '/qvac/v1/vla/models'

// `@qvac/vla-ggml` error codes, which reach the client on the SDK error.
const ADDON_FAILED_TO_LOAD_WEIGHTS = 30001
const ADDON_INVALID_CONFIG = 30004
const ADDON_INVALID_INPUT = 30006
const ADDON_JOB_ALREADY_RUNNING = 30007
// The native forward pass reports a malformed prompt (an out-of-vocabulary ID) this way.
const ADDON_INFERENCE_FAILED = 30010

const MODEL_ERRORS = {
  503: {
    model_not_loaded: 'The model is not loaded and lazy loading is disabled',
    model_load_failed: 'The model failed to load',
    model_load_timeout: 'The model did not load in time'
  }
}

const MODEL_LOOKUP = {
  404: { model_not_found: 'Unknown alias' }
}

const EXPERIMENTAL = '**Experimental**: the request and response shapes may change.'

const actionsDescription = `
${EXPERIMENTAL}

Predict an action chunk with a vision-language-action model (SmolVLA, π₀.₅ or GR00T), backed
by the SDK's \`vla()\`. \`model\` names a \`serve.models\` alias whose endpoint category is
\`vla\`.

Send one entry in \`images\` per camera, \`hparams.numCameras\` in all (π₀.₅ also takes fewer,
the leading cameras). Each is either raw RGB
\`pixels\` with their \`width\` and \`height\`, which the server letterboxes and normalises
to the model's vision size, or a preprocessed little-endian float32 \`tensor\`, which it
passes through. Patch-input models (GR00T) take \`tensor\` only.

\`tokens\` is the instruction tokenized with the model's own tokenizer; the server does not
tokenize. \`tokens\`, \`attentionMask\` and \`state\` are zero-padded to the model's sizes; a
\`tokenizerMaxLength\` of 0 (GR00T) means the prompt is sent unpadded. Read those sizes from
\`GET ${MODELS}/{model}\`.

A model runs one action request at a time: a request that arrives while another runs on
the same model gets 429. A client disconnect cancels the run.
`.trim()

const modelDescription = `
${EXPERIMENTAL}

A VLA model's hyperparameters and backend, from the SDK's \`vlaHparams()\`. Loads the model
when it is not loaded yet.
`.trim()

const embodimentDescription = `
${EXPERIMENTAL}

Switch a multi-embodiment GR00T model to another embodiment in the same GGUF, backed by the
SDK's \`vlaSetEmbodiment()\`. Nothing reloads. Returns the new hparams: re-read
\`numCameras\` before the next action request.

The switch is refused while an action request runs on the model, and for a model with a
single embodiment or that is not GR00T.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  const guard = createModelGuard()

  app.post(
    ACTIONS,
    {
      schema: {
        body: vlaActionsBody,
        response: {
          200: vlaActions,
          ...errorResponses({
            400: {
              invalid_json: 'Body is not valid JSON',
              missing_model: '`model` is missing',
              invalid_images:
                '`images` is missing, has the wrong camera count, or an entry has the wrong size or form for the model',
              invalid_state: "`state` is longer than the model's `maxStateDim`",
              invalid_tokens:
                "`tokens` is missing, has a negative ID, or is longer than the model's `tokenizerMaxLength`",
              invalid_attention_mask:
                '`attentionMask` does not have one entry per token, or has a 0 before a 1 on a discrete-state model (π₀.₅)',
              invalid_noise:
                '`noise` is missing for a model that needs it, or is not `chunkSize * maxActionDim` values',
              invalid_vla_request: 'The model refused the inputs',
              invalid_request: 'The body carries an unknown field',
              invalid_model_type: 'The alias is not a `vla` model'
            },
            ...MODEL_LOOKUP,
            413: { request_too_large: 'The body is over the size cap' },
            429: {
              request_rejected_by_policy:
                'Another action request or an embodiment switch is running on this model'
            },
            ...MODEL_ERRORS
          })
        },
        tags: [TAG],
        summary: 'Predict robot actions (experimental)',
        description: actionsDescription
      },
      preHandler: requireModel('vla')
    },
    async (req, reply) => {
      const { sdkModelId, alias } = req.qvacModel!
      const state = defaultState(app.qvac)

      // Held from the hparams read through the run, so a switch cannot change the
      // embodiment between validating the inputs and running them.
      const release = guard.enterAction(sdkModelId)
      let result
      try {
        const { hparams } = await callSdk('invalid_vla_request', () =>
          (state.vlaHparamsOverride ?? vlaHparams)({ modelId: sdkModelId })
        )
        const params = buildRunParams(req.body, hparams)
        // A client that left during the hparams read already fired `close`, so the
        // cancel bridge would never stop the run.
        if (reply.raw.destroyed) return reply

        app.qvac.logger.info(
          `  vla model=${alias} cameras=${params.images.length} tokens=${req.body.tokens.length}`
        )
        const run = (state.vlaOverride ?? vla)({ modelId: sdkModelId, ...params })
        bindClientDisconnectCancel(reply.raw, run.requestId, app.qvac.logger, state.cancelOverride)
        result = await run.catch((err: unknown) =>
          rethrow(err, 'invalid_vla_request', ADDON_INFERENCE_FAILED)
        )
      } finally {
        release()
      }

      app.qvac.logger.info(`  vla done ms=${result.stats?.total_ms ?? 0}`)
      return {
        object: 'vla.actions' as const,
        model: alias,
        chunk_size: result.chunkSize,
        action_dim: result.actionDim,
        actions: chunkRows(result.actions, result.chunkSize, result.actionDim),
        stats: result.stats ?? {}
      }
    }
  )

  app.get(
    `${MODELS}/:model`,
    {
      schema: {
        params: vlaModelParams,
        response: {
          200: vlaModel,
          ...errorResponses({
            400: { invalid_model_type: 'The alias is not a `vla` model' },
            ...MODEL_LOOKUP,
            ...MODEL_ERRORS
          })
        },
        tags: [TAG],
        summary: 'Retrieve VLA hyperparameters (experimental)',
        description: modelDescription
      }
    },
    async (req, reply) => {
      const { sdkModelId, alias } = await loadVla(req, reply)
      const state = defaultState(app.qvac)
      const result = await callSdk('invalid_vla_request', () =>
        (state.vlaHparamsOverride ?? vlaHparams)({ modelId: sdkModelId })
      )
      return {
        object: 'vla.model' as const,
        model: alias,
        backend_name: result.backendName,
        hparams: result.hparams
      }
    }
  )

  app.post(
    `${MODELS}/:model/embodiment`,
    {
      schema: {
        params: vlaModelParams,
        body: vlaEmbodimentBody,
        response: {
          200: vlaModel,
          ...errorResponses({
            400: {
              invalid_json: 'Body is not valid JSON',
              invalid_embodiment:
                '`embodiment` is malformed, unknown to the GGUF, or the model has a single embodiment or is not GR00T',
              invalid_request: 'The body carries an unknown field',
              invalid_model_type: 'The alias is not a `vla` model'
            },
            ...MODEL_LOOKUP,
            429: {
              request_rejected_by_policy:
                'An action request or another switch is running on this model'
            },
            ...MODEL_ERRORS
          })
        },
        tags: [TAG],
        summary: 'Switch a GR00T embodiment (experimental)',
        description: embodimentDescription
      }
    },
    async (req, reply) => {
      const { sdkModelId, alias } = await loadVla(req, reply)
      const state = defaultState(app.qvac)
      const embodiment = req.body.embodiment as VlaEmbodimentSelection

      const release = guard.enterSwitch(sdkModelId)
      try {
        const { hparams } = await callSdk('invalid_embodiment', () =>
          (state.vlaHparamsOverride ?? vlaHparams)({ modelId: sdkModelId })
        )
        // Only GR00T (patch input) carries embodiments; other addons fail the switch
        // with an error that does not name the request as the cause.
        if (hparams.imageInputMode !== 'patches') {
          throw new HttpError(400, 'invalid_embodiment', 'The model is not GR00T.')
        }
        app.qvac.logger.info(`  vla_embodiment model=${alias} to=${JSON.stringify(embodiment)}`)
        // A single-embodiment GGUF refuses the switch with the load-failure code.
        const result = await callSdk(
          'invalid_embodiment',
          () =>
            (state.vlaSetEmbodimentOverride ?? vlaSetEmbodiment)({
              modelId: sdkModelId,
              embodiment
            }),
          ADDON_FAILED_TO_LOAD_WEIGHTS
        )
        return { object: 'vla.model' as const, model: alias, hparams: result.hparams }
      } finally {
        release()
      }
    }
  )
}

const BUSY_SWITCH = 'An embodiment switch is running on this model.'
const BUSY_ACTION = 'An action request is running on this model.'

// The addon takes one job per model and rejects the rest, so refuse them here with a
// clear message instead.
function createModelGuard() {
  const actions = new Set<string>()
  const switching = new Set<string>()

  function enterAction(modelId: string): () => void {
    if (switching.has(modelId)) throw new HttpError(429, 'request_rejected_by_policy', BUSY_SWITCH)
    if (actions.has(modelId)) throw new HttpError(429, 'request_rejected_by_policy', BUSY_ACTION)
    actions.add(modelId)
    return () => actions.delete(modelId)
  }

  function enterSwitch(modelId: string): () => void {
    if (switching.has(modelId)) throw new HttpError(429, 'request_rejected_by_policy', BUSY_SWITCH)
    if (actions.has(modelId)) throw new HttpError(429, 'request_rejected_by_policy', BUSY_ACTION)
    switching.add(modelId)
    return () => switching.delete(modelId)
  }

  return { enterAction, enterSwitch }
}

function loadVla(req: FastifyRequest, reply: FastifyReply) {
  const { model } = req.params as { model: string }
  return resolveAndCheckModel(req, reply, model.trim(), 'vla')
}

interface RunParams {
  images: Float32Array[]
  imgWidth: number
  imgHeight: number
  state: Float32Array
  tokens: Int32Array
  mask: Uint8Array
  noise?: Float32Array
}

export function buildRunParams(body: VlaActionsBody, hparams: VlaHparams): RunParams {
  const size = hparams.visionImageSize
  const discrete = hparams.stateInputMode === 'discrete'
  const cameras = hparams.numCameras
  // π₀.₅ runs a checkpoint with a masked trailing camera slot by dropping that view.
  if (cameras !== undefined && discrete && body.images.length > cameras) {
    throw invalid(
      'images',
      `the model takes 1 to ${cameras} camera frames, got ${body.images.length}.`
    )
  }
  if (cameras !== undefined && !discrete && body.images.length !== cameras) {
    throw invalid('images', `the model takes ${cameras} camera frames, got ${body.images.length}.`)
  }
  const images = body.images.map((image, i) => imageTensor(image, i, hparams))

  const tokenCount = body.tokens.length
  // 0 means the prompt has no fixed length (GR00T): send it unpadded.
  const padTo = hparams.tokenizerMaxLength === 0 ? tokenCount : hparams.tokenizerMaxLength
  if (tokenCount > padTo) {
    throw invalid(
      'tokens',
      `${tokenCount} tokens is over the model's tokenizerMaxLength of ${hparams.tokenizerMaxLength}.`
    )
  }
  if (body.attentionMask !== undefined && body.attentionMask.length !== tokenCount) {
    throw invalid(
      'attentionMask',
      `expected ${tokenCount} entries, one per token, got ${body.attentionMask.length}.`
    )
  }
  // π₀.₅ reads the mask as a prompt length, so a 0 before a 1 breaks the native run.
  if (discrete && body.attentionMask !== undefined) {
    const firstZero = body.attentionMask.indexOf(0)
    if (firstZero !== -1 && body.attentionMask.indexOf(1, firstZero) !== -1) {
      throw invalid('attentionMask', 'the model takes 1s for the prompt, then 0s only.')
    }
  }
  const tokens = new Int32Array(padTo)
  tokens.set(body.tokens)
  const mask = new Uint8Array(padTo)
  if (body.attentionMask === undefined) mask.fill(1, 0, tokenCount)
  else mask.set(body.attentionMask)

  let state: Float32Array = new Float32Array(0)
  if (!discrete) {
    const values = body.state ?? []
    if (values.length > hparams.maxStateDim) {
      throw invalid(
        'state',
        `${values.length} values is over the model's maxStateDim of ${hparams.maxStateDim}.`
      )
    }
    state = vlaPadState(values, hparams.maxStateDim)
  }

  const noiseLength = hparams.chunkSize * hparams.maxActionDim
  // GR00T and π₀.₅ do not sample a prior of their own.
  if (body.noise === undefined && (discrete || hparams.imageInputMode === 'patches')) {
    throw invalid('noise', `the model needs a noise prior of ${noiseLength} values.`)
  }
  if (body.noise !== undefined && body.noise.length !== noiseLength) {
    throw invalid('noise', `expected ${noiseLength} values, got ${body.noise.length}.`)
  }

  return {
    images,
    imgWidth: size,
    imgHeight: size,
    state,
    tokens,
    mask,
    ...(body.noise !== undefined ? { noise: Float32Array.from(body.noise) } : {})
  }
}

function imageTensor(image: VlaImageInput, index: number, hparams: VlaHparams): Float32Array {
  const field = `images[${index}]`
  const patches = hparams.imageInputMode === 'patches'
  const expected = patches
    ? (hparams.imagePatchElems ?? 0)
    : 3 * hparams.visionImageSize * hparams.visionImageSize

  if ('tensor' in image) {
    const bytes = Buffer.from(image.tensor, 'base64')
    if (bytes.length !== expected * 4) {
      throw invalid(field, `expected ${expected} float32 values, got ${bytes.length / 4}.`)
    }
    // Copy so the floats are 4-byte aligned whatever offset the Buffer has.
    const floats = new Float32Array(expected)
    new Uint8Array(floats.buffer).set(bytes)
    return floats
  }

  if (patches) {
    throw invalid(field, 'the model takes pre-patchified `tensor` input, not `pixels`.')
  }
  const pixels = Buffer.from(image.pixels, 'base64')
  const want = image.width * image.height * 3
  if (pixels.length !== want) {
    throw invalid(
      field,
      `expected ${want} bytes for ${image.width}x${image.height} RGB, got ${pixels.length}.`
    )
  }
  return vlaPreprocessImage(new Uint8Array(pixels), image.width, image.height, {
    size: hparams.visionImageSize,
    layout: image.layout ?? 'hwc',
    scale: 1 / 255
  })
}

function chunkRows(actions: Float32Array, chunkSize: number, actionDim: number): number[][] {
  const rows: number[][] = []
  for (let i = 0; i < chunkSize; i++) {
    rows.push(Array.from(actions.subarray(i * actionDim, (i + 1) * actionDim)))
  }
  return rows
}

function invalid(field: string, detail: string): HttpError {
  const code = VLA_FIELD_CODES[field.split('[')[0]!] ?? 'invalid_request'
  return new HttpError(400, code, `${field}: ${detail}`)
}

async function callSdk<T>(code: string, call: () => Promise<T>, inputCode?: number): Promise<T> {
  try {
    return await call()
  } catch (err) {
    return rethrow(err, code, inputCode)
  }
}

// `inputCode` is an addon code that means a bad request on this route only.
function rethrow(err: unknown, code: string, inputCode?: number): never {
  const errCode = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  if (
    err instanceof RequestValidationFailedError ||
    errCode === SDK_SERVER_ERROR_CODES.PLUGIN_REQUEST_VALIDATION_FAILED ||
    errCode === ADDON_INVALID_CONFIG ||
    errCode === ADDON_INVALID_INPUT ||
    (inputCode !== undefined && errCode === inputCode)
  ) {
    throw new HttpError(400, code, message)
  }
  if (errCode === ADDON_JOB_ALREADY_RUNNING) {
    throw new HttpError(429, 'request_rejected_by_policy', message)
  }
  throw err
}

export default plugin
