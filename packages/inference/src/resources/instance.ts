import { createSystemResourceCollector } from '@/resources/collector'
import type { ResourceCollectorDependencies, SystemResourceCollector } from '@/resources/types'

let resourceCollector: SystemResourceCollector | undefined

export function initializeResourceCollector(dependencies: ResourceCollectorDependencies) {
  if (!resourceCollector) {
    resourceCollector = createSystemResourceCollector(dependencies)
  }

  return resourceCollector
}

export function getResourceCollector() {
  return resourceCollector
}

export function destroyResourceCollector() {
  resourceCollector?.destroy()
  resourceCollector = undefined
}
