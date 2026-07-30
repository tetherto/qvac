import { createSystemResourceCollector } from '@/server/bare/resources/collector'
import type {
  ResourceCollectorDependencies,
  SystemResourceCollector
} from '@/server/bare/resources/types'

let workerResourceCollector: SystemResourceCollector | undefined

export function initializeWorkerResourceCollector(dependencies: ResourceCollectorDependencies) {
  if (!workerResourceCollector) {
    workerResourceCollector = createSystemResourceCollector(dependencies)
  }

  return workerResourceCollector
}

export function getWorkerResourceCollector() {
  return workerResourceCollector
}

export function destroyWorkerResourceCollector() {
  workerResourceCollector?.destroy()
  workerResourceCollector = undefined
}
