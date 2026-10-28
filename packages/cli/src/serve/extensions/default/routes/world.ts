import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import type { FastifyRequest } from 'fastify'
import {
  RequestValidationFailedError,
  SDK_SERVER_ERROR_CODES,
  worldCreateScene,
  worldStep,
  type WorldStepStats
} from '@qvac/sdk'
import { HttpError } from '@/serve/lib/http-error'
import { multipartToBodyOptional } from '@/serve/lib/multipart'
import { JPEG, PNG, createImageInput } from '@/serve/lib/image-input'
import { errorResponses } from '@/serve/lib/error-responses'
import { endSSE, initSSE, sendSSE } from '@/serve/lib/sse'
import { requireModel, resolveAndCheckModel } from '@/serve/core/plugins/require-model'
import { bindClientDisconnectCancel } from '@/serve/core/cancel-bridge'
import { defaultState } from '@/serve/extensions/default/state'
import type { WorldSceneRecord } from '@/serve/extensions/default/world-scenes-store'
import {
  MAX_SCENE_IMAGE_BYTES,
  MAX_SCENE_PIXELS,
  sceneIdParams,
  worldScene,
  worldSceneBody,
  worldStep as worldStepResponse,
  worldStepBody,
  type WorldStepStatsResponse
} from '@/serve/extensions/default/schemas/world'

const TAG = 'World'
const SCENES = '/qvac/v1/world/scenes'

const image = createImageInput([PNG, JPEG])

const MODEL_ERRORS = {
  503: {
    model_not_loaded: 'The model is not loaded and lazy loading is disabled',
    model_load_failed: 'The model failed to load',
    model_load_timeout: 'The model did not load in time'
  }
}

const BUSY = {
  429: { request_rejected_by_policy: 'A scene or step is already running on this model' }
}

const createDescription = `
**Experimental**: the request and response shapes may change.

Create a world on a configured ABot-World model, backed by the SDK's
\`worldCreateScene()\`. \`model\` names a \`serve.models\` alias whose endpoint
category is \`world\`: an \`sdcpp-generation\` model with \`config.mode: "world"\`.

A model holds one live scene. Creating a scene replaces the model's previous one
and restarts the walk; the older id then answers \`409 scene_replaced\`.

Send JSON or \`multipart/form-data\`. \`image\` is the first frame, a PNG or JPEG
up to ${MAX_SCENE_IMAGE_BYTES / (1024 * 1024)} MB: a multipart file part, a base64
data URL, or the \`id\` of a file uploaded with \`POST /v1/files\`. \`width\` and
\`height\` are multiples of 32 whose product stays within ${MAX_SCENE_PIXELS} pixels.

Scene creation cannot be cancelled: a client disconnect drops the response, but
the scene is still created and replaces the previous one.
`.trim()

const stepDescription = `
**Experimental**: the request and response shapes may change.

Generate the next block of frames for a scene, backed by the SDK's \`worldStep()\`.
\`keys\` are held for the whole block: \`W\`, \`A\`, \`S\`, \`D\` move and \`I\`, \`J\`,
\`K\`, \`L\` steer the camera. Omit them to idle.

A block is 9 frames after the model loads and 12 after that at the default
\`world.numFramePerBlock\`. Frames are PNG, or JPEG when the model sets
\`world.frameJpegQuality\`. One block runs at a time per model: send the next step
after the previous one returns.

With \`stream: true\` the response is server-sent events: one
\`world.step.frame\` event per frame as it is decoded, then \`world.step.completed\`
with the block's stats, then \`[DONE]\`. A client disconnect cancels the block.
`.trim()

// lunte-disable-next-line require-await
const plugin: FastifyPluginAsyncZod = async (app) => {
  app.post(
    SCENES,
    {
      schema: {
        body: worldSceneBody,
        response: {
          201: worldScene,
          ...errorResponses({
            400: {
              invalid_json: 'Body is not valid JSON',
              invalid_multipart: 'The multipart body cannot be parsed',
              missing_model: '`model` is missing',
              missing_prompt: '`prompt` is missing or empty',
              missing_image: '`image` is missing',
              empty_input: '`image` has no bytes',
              invalid_data_url: '`image` is a data URL that is not base64',
              file_not_found: '`image` is neither a data URL nor an uploaded file id',
              unsupported_image_format: '`image` is not a PNG or JPEG',
              image_too_large: `\`image\` is over ${MAX_SCENE_IMAGE_BYTES} bytes`,
              invalid_dimensions:
                '`width` or `height` is not a multiple of 32 up to 4096, or their product is over the pixel ceiling',
              invalid_scene:
                'The model refused the scene: an unreadable or oversized first frame, missing encoders, or a block over the memory ceiling',
              invalid_request: 'The body carries an unknown field',
              invalid_model_type: 'The alias is not a `world` model'
            },
            404: { model_not_found: 'Unknown alias' },
            413: { request_too_large: 'The upload is over the size cap' },
            ...BUSY,
            ...MODEL_ERRORS
          })
        },
        tags: [TAG],
        summary: 'Create a world scene (experimental)',
        description: createDescription,
        consumes: ['application/json', 'multipart/form-data']
      },
      preValidation: multipartToBodyOptional,
      preHandler: [
        // lunte-disable-next-line require-await
        async function (req) {
          image.read(req, req.body.image)
          if (image.get(req).length > MAX_SCENE_IMAGE_BYTES) {
            throw new HttpError(
              400,
              'image_too_large',
              `image: over the ${MAX_SCENE_IMAGE_BYTES}-byte limit.`
            )
          }
        },
        requireModel('world')
      ]
    },
    async (req, reply) => {
      const { prompt, width, height, returnPack } = req.body
      const { sdkModelId, alias } = req.qvacModel!
      const state = defaultState(app.qvac)
      const bytes = image.get(req)

      app.qvac.logger.info(
        `  world_scene model=${alias} bytes=${bytes.length} size=${width ?? 832}x${height ?? 480}`
      )

      const params = {
        modelId: sdkModelId,
        prompt,
        image: new Uint8Array(bytes),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {})
      }
      const create = state.worldCreateSceneOverride ?? worldCreateScene
      const [stats, pack] = await callSdk(async () => {
        if (returnPack === true) {
          const result = create({ ...params, returnPack: true })
          return Promise.all([result.stats, result.scene])
        }
        const result = create(params)
        return [await result.stats, undefined] as const
      })

      const scene = state.worldScenes.add({
        alias,
        sdkModelId,
        ...(stats?.width !== undefined ? { width: stats.width } : {}),
        ...(stats?.height !== undefined ? { height: stats.height } : {}),
        ...(stats?.sceneCreateMs !== undefined ? { sceneCreateMs: stats.sceneCreateMs } : {})
      })
      app.qvac.logger.info(`  world_scene done id=${scene.id} ms=${stats?.sceneCreateMs ?? 0}`)

      reply.code(201)
      return {
        ...sceneResource(scene, 'active'),
        ...(pack !== undefined ? { pack: Buffer.from(pack).toString('base64') } : {})
      }
    }
  )

  app.get(
    `${SCENES}/:id`,
    {
      schema: {
        params: sceneIdParams,
        response: {
          200: worldScene,
          ...errorResponses({ 404: { scene_not_found: 'Unknown scene id' } })
        },
        tags: [TAG],
        summary: 'Retrieve a world scene (experimental)',
        description:
          '**Experimental.** `status` is `replaced` once a newer scene was created on the same model, or the model reloaded.'
      }
    },
    // lunte-disable-next-line require-await
    async (req) => {
      const scene = findScene(req, req.params.id)
      const entry = app.qvac.registry.getEntry(scene.alias)
      const live = defaultState(app.qvac).worldScenes.isActive(
        scene,
        entry?.state === app.qvac.registry.STATES.READY ? (entry.sdkModelId ?? entry.id) : undefined
      )
      return sceneResource(scene, live ? 'active' : 'replaced')
    }
  )

  app.post(
    `${SCENES}/:id/steps`,
    {
      schema: {
        params: sceneIdParams,
        body: worldStepBody,
        response: {
          200: worldStepResponse,
          ...errorResponses({
            400: {
              invalid_json: 'Body is not valid JSON',
              invalid_keys: '`keys` is not an array of W, A, S, D, I, J, K, L',
              invalid_request: 'The body carries an unknown field'
            },
            404: { scene_not_found: 'Unknown scene id' },
            409: {
              scene_replaced:
                'A newer scene was created on the same model, or the model reloaded; create a new scene'
            },
            ...BUSY,
            ...MODEL_ERRORS
          })
        },
        tags: [TAG],
        summary: 'Step a world scene (experimental)',
        description: stepDescription,
        produces: ['application/json', 'text/event-stream']
      }
    },
    async (req, reply) => {
      const scene = findScene(req, req.params.id)
      const { sdkModelId } = await resolveAndCheckModel(req, reply, scene.alias, 'world')
      const state = defaultState(app.qvac)
      if (!state.worldScenes.isActive(scene, sdkModelId)) {
        throw new HttpError(
          409,
          'scene_replaced',
          `Scene "${scene.id}" is no longer live on model "${scene.alias}". Create a new scene.`
        )
      }

      const keys = req.body.keys ?? []
      app.qvac.logger.info(`  world_step scene=${scene.id} keys=${keys.join('+') || 'idle'}`)

      const run = callSdk(() =>
        (state.worldStepOverride ?? worldStep)({ modelId: sdkModelId, keys })
      )
      bindClientDisconnectCancel(reply.raw, run.requestId, app.qvac.logger, state.cancelOverride)

      if (req.body.stream === true) {
        // Frames arrive on frameStream; the aggregate rejects with the same error.
        run.frames.catch(() => undefined)
        let format: 'png' | 'jpeg' | undefined
        let index = 0
        try {
          for await (const frame of run.frameStream) {
            if (index === 0) {
              initSSE(reply)
              format = frameFormat(frame)
            }
            sendSSE(reply.raw, {
              type: 'world.step.frame',
              scene_id: scene.id,
              index: index++,
              output_format: format,
              b64_json: Buffer.from(frame).toString('base64')
            })
          }
        } catch (err) {
          rethrow(err)
        }
        const stats = await run.stats.catch(rethrow)
        if (index === 0) initSSE(reply)
        sendSSE(reply.raw, {
          type: 'world.step.completed',
          scene_id: scene.id,
          frames: index,
          stats: stepStats(stats)
        })
        endSSE(reply.raw)
        return reply
      }

      const [frames, stats] = await Promise.all([run.frames, run.stats]).catch(rethrow)
      app.qvac.logger.info(`  world_step done frames=${frames.length} ms=${stats?.stepMs ?? 0}`)
      return {
        object: 'world.step' as const,
        scene_id: scene.id,
        output_format: frames[0] !== undefined ? frameFormat(frames[0]) : 'png',
        data: frames.map((frame) => ({ b64_json: Buffer.from(frame).toString('base64') })),
        stats: stepStats(stats)
      }
    }
  )
}

function findScene(req: FastifyRequest, id: string): WorldSceneRecord {
  const scene = defaultState(req.server.qvac).worldScenes.get(id)
  if (scene === undefined) {
    throw new HttpError(404, 'scene_not_found', `Scene "${id}" not found.`)
  }
  return scene
}

function sceneResource(scene: WorldSceneRecord, status: 'active' | 'replaced') {
  return {
    id: scene.id,
    object: 'world.scene' as const,
    created: scene.created,
    model: scene.alias,
    status,
    ...(scene.width !== undefined ? { width: scene.width } : {}),
    ...(scene.height !== undefined ? { height: scene.height } : {}),
    ...(scene.sceneCreateMs !== undefined ? { scene_create_ms: scene.sceneCreateMs } : {})
  }
}

function stepStats(stats: WorldStepStats | undefined): WorldStepStatsResponse {
  if (stats === undefined) return {}
  return {
    ...(stats.stepMs !== undefined ? { step_ms: stats.stepMs } : {}),
    ...(stats.totalSteps !== undefined ? { total_steps: stats.totalSteps } : {}),
    ...(stats.totalFrames !== undefined ? { total_frames: stats.totalFrames } : {}),
    ...(stats.width !== undefined ? { width: stats.width } : {}),
    ...(stats.height !== undefined ? { height: stats.height } : {})
  }
}

function frameFormat(frame: Uint8Array): 'png' | 'jpeg' {
  return JPEG.signature.every((byte, i) => frame[i] === byte) ? 'jpeg' : 'png'
}

// Client-side validation throws synchronously; the worker's arrives on the result.
function callSdk<T>(call: () => T): T {
  try {
    const result = call()
    return (result instanceof Promise ? result.catch(rethrow) : result) as T
  } catch (err) {
    return rethrow(err)
  }
}

function rethrow(err: unknown): never {
  if (err instanceof RequestValidationFailedError) {
    throw new HttpError(400, 'invalid_scene', err.message)
  }
  const code = (err as { code?: unknown } | null)?.code
  if (code === SDK_SERVER_ERROR_CODES.PLUGIN_REQUEST_VALIDATION_FAILED) {
    throw new HttpError(400, 'invalid_scene', (err as Error).message)
  }
  throw err
}

export default plugin
