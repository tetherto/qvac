import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type CreateServerOptions } from '../helpers/server.js'
import { openaiState } from '@/serve/extensions/openai/state'
import type { VideoClientParams } from '@qvac/sdk'

describe('serve: H3 video', () => {
  it('loads the four-file layout and serves the result of a five-second request', async (t) => {
    const config = {
      mode: 'video',
      llmModelSrc: '/models/encoder.gguf',
      vaeModelSrc: '/models/video.safetensors',
      audioVaeModelSrc: '/models/audio.safetensors',
      backend: 'cuda',
      max_vram: 'cuda0=6',
      stream_layers: false
    }
    const loads: Parameters<NonNullable<CreateServerOptions['loadModelOverride']>>[0][] = []
    const requests: VideoClientParams[] = []
    const app = await createServer(t, {
      config: {
        serve: {
          models: {
            'neutral-alias': {
              type: 'sdcpp-video',
              src: '/models/denoiser.gguf',
              config,
              preload: false
            }
          }
        }
      },
      loadModelOverride: (params) => {
        loads.push(params)
        return Promise.resolve('loaded-h3')
      }
    })
    await app.ready()
    const bytes = Buffer.from('native AVI bytes')
    openaiState(app.qvac).videoOverride = (params) => {
      requests.push(params)
      return {
        requestId: 'h3-request',
        progressStream: (async function* () {
          yield await Promise.resolve({ step: 1, totalSteps: 1, elapsedMs: 1 })
        })(),
        outputs: Promise.resolve([bytes]),
        stats: Promise.resolve(undefined)
      }
    }
    const created = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      payload: { model: 'neutral-alias', prompt: 'Steam rises from coffee.', seconds: '5' }
    })
    assert.equal(created.statusCode, 200, created.body)
    assert.equal(loads.length, 1)
    assert.equal(loads[0]?.modelType, 'sdcpp-generation')
    assert.deepEqual(loads[0]?.modelConfig, config)
    assert.equal(requests[0]?.modelId, 'loaded-h3')
    assert.equal(requests[0]?.video_frames, 124)
    assert.equal(requests[0]?.fps, undefined)

    const { id } = created.json<{ id: string }>()
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await app.inject({ method: 'GET', url: `/v1/videos/${id}` })
      const job = response.json<{ status: string }>()
      if (job.status === 'completed') break
      assert.notEqual(job.status, 'failed', response.body)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const content = await app.inject({
      method: 'GET',
      url: `/v1/videos/${id}/content?format=avi`
    })
    assert.equal(content.statusCode, 200, content.body)
    assert.deepEqual(content.rawPayload, bytes)
  })
})
