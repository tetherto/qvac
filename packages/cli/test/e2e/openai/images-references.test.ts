import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DiffusionClientParams } from '@qvac/sdk'
import { createServer } from '../helpers/server.js'
import { multipart } from '../helpers/http.js'
import { tinyPng } from '../helpers/fixtures.js'
import { openaiState } from '@/serve/extensions/openai/state'

const models = {
  flux: {
    prediction: 'flux2_flow',
    llmModelSrc: '/models/encoder.gguf',
    vaeModelSrc: '/models/vae.safetensors'
  },
  qwen: {
    llmModelSrc: '/models/encoder.gguf',
    projectionModelSrc: '/models/projector.gguf',
    vaeModelSrc: '/models/vae.safetensors'
  }
}

for (const [model, config] of Object.entries(models)) {
  describe(`serve: ${model} image references`, () => {
    for (const fieldnames of [
      ['image'],
      ['image[]'],
      ['image[]', 'image[]', 'image[]'],
      ['image', 'image[]', 'image']
    ]) {
      it(`forwards ${fieldnames.join(', ')} in upload order`, async (t) => {
        const app = await createServer(t, {
          config: {
            serve: {
              models: {
                [model]: {
                  type: 'sdcpp-generation',
                  src: '/models/denoiser.gguf',
                  config,
                  preload: false
                }
              }
            }
          },
          loadModelOverride: () => Promise.resolve(`loaded-${model}`)
        })
        await app.ready()
        const requests: DiffusionClientParams[] = []
        const output = tinyPng()
        const state = openaiState(app.qvac)
        state.diffusionOverride = (params) => {
          requests.push(params)
          return {
            progressStream: (async function* () {
              yield await Promise.resolve({ step: 1, totalSteps: 1, elapsedMs: 1 })
            })(),
            outputs: Promise.resolve([output]),
            stats: Promise.resolve(undefined)
          }
        }
        const warnings: string[] = []
        app.qvac.logger.warn = (message) => warnings.push(message)
        const images = fieldnames.map((_, index) =>
          Buffer.concat([tinyPng(), Buffer.from([index])])
        )
        const response = await app.inject({
          method: 'POST',
          url: '/v1/images/edits',
          ...multipart([
            { name: 'model', value: model },
            { name: 'prompt', value: 'Compose the referenced subjects.' },
            ...fieldnames.map((name, index) => ({
              name,
              filename: `reference-${index}.png`,
              contentType: 'image/png',
              data: images[index]!
            }))
          ])
        })
        assert.equal(response.statusCode, 200, response.body)
        assert.equal(requests.length, 1)
        const request = requests[0]!
        assert.equal(request.modelId, `loaded-${model}`)
        if (images.length === 1) {
          assert.deepEqual(request.init_image, images[0])
          assert.equal(request.init_images, undefined)
        } else {
          assert.deepEqual(request.init_images, images)
          assert.equal(request.init_image, undefined)
        }
        assert.deepEqual(response.json<{ data: { b64_json: string }[] }>().data, [
          { b64_json: output.toString('base64') }
        ])
        assert.ok(!warnings.some((warning) => warning.includes('using only the first')))
      })
    }
  })
}
