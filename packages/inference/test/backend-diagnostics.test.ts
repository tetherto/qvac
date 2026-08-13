import test from 'brittle'
import { BACKEND_DIAGNOSTICS_KEY } from '@/schemas'
import { buildOperationEvent } from '@/profiling'
import {
  attachBackendDiagnostics,
  forwardBackendDiagnostics,
  readBackendDiagnostics
} from '@/profiling/backend-diagnostics'

test('operation metrics: attaches backend selection diagnostics', (t) => {
  const diagnostics = {
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
  } as const
  const response = attachBackendDiagnostics({}, diagnostics)

  const event = buildOperationEvent(
    'unregisteredBackendOp',
    'profile-backend',
    100,
    50,
    {},
    response
  )

  t.alike(event?.backend, diagnostics)
})

test('backend diagnostics helper rejects malformed producer metadata', (t) => {
  t.exception(() =>
    attachBackendDiagnostics(
      {},
      {
        selectedBackend: '',
        selectedDevice: 'gpu'
      }
    )
  )
})

test('backend diagnostics survive model-factory result forwarding', (t) => {
  const diagnostics = {
    selectedBackend: 'llama.cpp-metal',
    selectedDevice: 'gpu'
  } as const
  const pluginResult = attachBackendDiagnostics({ model: {} }, diagnostics)
  const loadResult = forwardBackendDiagnostics({}, pluginResult)

  t.alike(readBackendDiagnostics(loadResult), diagnostics)
})

test('operation metrics: drops malformed backend diagnostics', (t) => {
  const response = {
    [BACKEND_DIAGNOSTICS_KEY]: {
      selectedBackend: '',
      selectedDevice: 'gpu'
    }
  }

  const event = buildOperationEvent('completionStream', 'profile-backend', 100, 50, {}, response)

  t.absent(event?.backend)
})
