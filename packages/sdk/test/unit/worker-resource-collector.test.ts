import test from 'brittle'
import {
  destroyWorkerResourceCollector,
  getWorkerResourceCollector,
  initializeWorkerResourceCollector
} from '@/server/bare/resources/worker-collector'

function createDependencies() {
  const calls = {
    cpuCreated: 0,
    gpuCreated: 0,
    cpuDestroyed: 0,
    gpuDestroyed: 0
  }

  return {
    calls,
    dependencies: {
      cpuArchitectures: [1, 2, 3, 4],
      gpuTypes: [1, 2, 3, 4],
      createCPUInfo() {
        calls.cpuCreated++
        return {
          query() {
            return {
              name: 'CPU',
              vendor: 'Vendor',
              arch: 1,
              physicalCores: 1,
              logicalCores: 1,
              performanceCores: 1,
              efficiencyCores: 0,
              frequency: undefined,
              cacheLine: undefined,
              memory: 100
            }
          },
          sample() {
            return {
              compute: 0,
              memoryUsed: 0,
              memoryTotal: 100
            }
          },
          destroy() {
            calls.cpuDestroyed++
          }
        }
      },
      createGPUInfo() {
        calls.gpuCreated++
        return {
          gpus() {
            return []
          },
          sample() {
            throw new Error('no GPUs')
          },
          destroy() {
            calls.gpuDestroyed++
          }
        }
      },
      createGPUId() {
        return 'opaque-test-id'
      },
      now() {
        return 0
      }
    }
  }
}

test('owns at most one collector per worker', (t) => {
  destroyWorkerResourceCollector()
  const { calls, dependencies } = createDependencies()

  const first = initializeWorkerResourceCollector(dependencies)
  const second = initializeWorkerResourceCollector(dependencies)

  t.is(first, second)
  t.is(getWorkerResourceCollector(), first)
  t.is(calls.cpuCreated, 1)
  t.is(calls.gpuCreated, 1)

  destroyWorkerResourceCollector()
})

test('destroys worker contexts once and clears ownership', (t) => {
  destroyWorkerResourceCollector()
  const { calls, dependencies } = createDependencies()
  initializeWorkerResourceCollector(dependencies)

  destroyWorkerResourceCollector()
  destroyWorkerResourceCollector()

  t.is(calls.cpuDestroyed, 1)
  t.is(calls.gpuDestroyed, 1)
  t.is(getWorkerResourceCollector(), undefined)
})
