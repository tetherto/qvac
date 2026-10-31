import test from 'brittle'
import { embed } from '@/plugins/ops/embed'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { ModelType, embedResponseSchema } from '@/schemas/index'
import type { EmbedStats } from '@/utils/addon-responses'

function fixture(t: { teardown(cleanup: () => void): void }, id: string, stats?: EmbedStats) {
  registerModel(id, {
    model: {
      run: async () => ({ stats, await: async () => [[new Float32Array([3, 4])]] })
    } as unknown as AnyModel,
    path: '/tmp/embed-stats.gguf',
    config: { backend: ['cuda', 'vulkan'] },
    modelType: ModelType.llamacppEmbedding
  })
  t.teardown(() => {
    unregisterModel(id)
  })
}

test('embed: maps the native backendName through single and batch responses', async (t) => {
  fixture(t, 'embed-backend-name', {
    backendDevice: 'gpu',
    backendName: 'metal',
    total_tokens: 2,
    total_time_ms: 3
  })
  for (const text of ['hello', ['hello']]) {
    const response = await embed({ modelId: 'embed-backend-name', text })
    t.is(response.stats?.backendName, 'metal')
    t.is(response.stats?.backendDevice, 'gpu')
    const parsed = embedResponseSchema.parse({ type: 'embed', success: true, ...response })
    t.is(parsed.stats?.backendName, 'metal')
  }
})

test('embed: preserves CPU fallback and does not infer names for older addons', async (t) => {
  fixture(t, 'embed-backend-cpu', { backendDevice: 'cpu', backendName: 'cpu' })
  fixture(t, 'embed-backend-legacy', { backendDevice: 'gpu' })
  fixture(t, 'embed-backend-empty')
  t.is((await embed({ modelId: 'embed-backend-cpu', text: 'hello' })).stats?.backendName, 'cpu')
  const legacy = await embed({ modelId: 'embed-backend-legacy', text: 'hello' })
  t.alike(legacy.stats, { backendDevice: 'gpu' })
  t.is((await embed({ modelId: 'embed-backend-empty', text: 'hello' })).stats, undefined)
})
