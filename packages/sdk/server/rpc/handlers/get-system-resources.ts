import type {
  GetSystemResourcesRequest,
  GetSystemResourcesResponse
} from '@/schemas/system-resources'
import { getWorkerResourceCollector } from '@/server/bare/resources/worker-collector'

export function handleGetSystemResources(
  request: GetSystemResourcesRequest
): GetSystemResourcesResponse {
  const collector = getWorkerResourceCollector()

  if (!collector) {
    return {
      type: 'getSystemResources',
      capabilities: {
        cpu: {
          status: 'failed',
          reason: 'CPU resource collector is not initialized'
        },
        memory: {
          totalBytes: {
            status: 'failed',
            reason: 'CPU resource collector is not initialized'
          }
        },
        gpus: {
          status: 'failed',
          reason: 'GPU resource collector is not initialized'
        }
      },
      ...(request.sample && {
        sample: {
          sampledAt: Date.now(),
          cpu: {
            status: 'failed',
            reason: 'CPU resource collector is not initialized'
          },
          memory: {
            usedBytes: {
              status: 'failed',
              reason: 'CPU resource collector is not initialized'
            },
            totalBytes: {
              status: 'failed',
              reason: 'CPU resource collector is not initialized'
            }
          },
          gpus: {
            status: 'failed',
            reason: 'GPU resource collector is not initialized'
          }
        }
      })
    }
  }

  return {
    type: 'getSystemResources',
    capabilities: collector.getCapabilities(),
    ...(request.sample && { sample: collector.sample() })
  }
}
