import test from 'brittle'
import {
  backendProbeResultSchema,
  inferenceBackendDiagnosticsSchema
} from '@/schemas/system-resources'

test('backend diagnostics validate probe, selection, and fallback details', (t) => {
  t.ok(
    inferenceBackendDiagnosticsSchema.safeParse({
      selectedBackend: 'llama.cpp-metal',
      selectedDevice: 'gpu',
      graphicsApi: 'metal',
      driver: { name: 'Metal', version: '3' },
      gpuId: 'gpu-opaque-1',
      fallback: {
        requestedBackend: 'llama.cpp-vulkan',
        requestedDevice: 'gpu',
        reason: 'Vulkan backend is unavailable'
      },
      probe: {
        status: 'compatible',
        backend: 'llama.cpp-metal'
      }
    }).success
  )
  t.absent(
    backendProbeResultSchema.safeParse({
      status: 'incompatible',
      backend: ''
    }).success,
    'probe backend cannot be empty'
  )
  t.absent(
    inferenceBackendDiagnosticsSchema.safeParse({
      selectedBackend: 'llama.cpp-cpu',
      selectedDevice: 'cpu',
      fallback: {}
    }).success,
    'fallback requires a reason'
  )
})
