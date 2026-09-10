import { getSystemResources, type ResourceMetric, type SystemResources } from '@qvac/sdk'
import {
  BaseExecutor,
  ValidationHelpers,
  type Expectation,
  type TestResult
} from '@qvac/test-suite'
import {
  systemResourcesCapabilities,
  systemResourcesInvalidInput,
  systemResourcesSample,
  systemResourcesTests
} from '../../system-resources-tests.js'

function assertMetric(metric: ResourceMetric<unknown>, label: string) {
  if (metric.status === 'supported') {
    if (!metric.provenance.source) {
      throw new Error(`${label} has no provenance source`)
    }
    return
  }

  if ('value' in metric) {
    throw new Error(`${label} exposes a value with status ${metric.status}`)
  }
}

function assertUtilization(metric: ResourceMetric<number>, label: string) {
  assertMetric(metric, label)
  if (metric.status === 'supported' && (metric.value < 0 || metric.value > 1)) {
    throw new Error(`${label} is outside 0..1: ${metric.value}`)
  }
}

function assertCapabilities(resources: SystemResources) {
  assertMetric(resources.capabilities.cpu, 'capabilities.cpu')
  assertMetric(resources.capabilities.memory.totalBytes, 'capabilities.memory.totalBytes')
  assertMetric(resources.capabilities.gpus, 'capabilities.gpus')

  if (resources.capabilities.gpus.status !== 'supported') return

  for (const gpu of resources.capabilities.gpus.value) {
    if (!gpu.id) throw new Error('GPU has no opaque ID')
    for (const rawIdentity of ['vendorId', 'deviceId', 'subsystemId', 'revision']) {
      if (rawIdentity in gpu) {
        throw new Error(`GPU exposes private identity field ${rawIdentity}`)
      }
    }
  }
}

type SampleMemory = NonNullable<SystemResources['sample']>['memory']

function describeMetric(metric: ResourceMetric<number>) {
  return metric.status === 'supported' ? String(metric.value) : metric.status
}

/** Grades the per-process memory pair. */
function assertProcessMemory(memory: SampleMemory, platform: string | undefined) {
  assertMetric(memory.processUsedBytes, 'sample.memory.processUsedBytes')
  assertMetric(memory.processAvailableBytes, 'sample.memory.processAvailableBytes')

  const allowance = memory.processAvailableBytes
  if (platform === 'ios' && allowance.status !== 'supported') {
    throw new Error(`sample.memory.processAvailableBytes is ${allowance.status} on iOS`)
  }

  if (allowance.status !== 'supported') return

  if (allowance.value <= 0) {
    throw new Error(`sample.memory.processAvailableBytes is not positive: ${allowance.value}`)
  }
  if (allowance.provenance.scope !== 'process') {
    throw new Error(
      `sample.memory.processAvailableBytes carries scope ${String(allowance.provenance.scope)}`
    )
  }
}

function assertSample(resources: SystemResources): SampleMemory {
  if (!resources.sample) throw new Error('Requested sample is missing')

  assertUtilization(resources.sample.cpu, 'sample.cpu')
  assertMetric(resources.sample.memory.usedBytes, 'sample.memory.usedBytes')
  assertMetric(resources.sample.memory.totalBytes, 'sample.memory.totalBytes')
  assertMetric(resources.sample.gpus, 'sample.gpus')

  if (
    resources.capabilities.gpus.status === 'supported' &&
    resources.sample.gpus.status === 'supported'
  ) {
    const capabilityIds = resources.capabilities.gpus.value.map((gpu) => gpu.id)
    const sampleIds = resources.sample.gpus.value.map((gpu) => gpu.id)
    if (capabilityIds.join(',') !== sampleIds.join(',')) {
      throw new Error('Capability and sample GPU IDs do not correlate')
    }

    for (const gpu of resources.sample.gpus.value) {
      assertUtilization(gpu.compute, `sample.gpus.${gpu.id}.compute`)
      assertUtilization(gpu.encode, `sample.gpus.${gpu.id}.encode`)
      assertUtilization(gpu.decode, `sample.gpus.${gpu.id}.decode`)
    }
  }

  return resources.sample.memory
}

export class SystemResourcesExecutor extends BaseExecutor<typeof systemResourcesTests> {
  pattern = /^system-resources-/

  /** Host platform, where the consumer knows it. */
  readonly #platform: string | undefined

  constructor(platform?: string) {
    super()
    this.#platform = platform
  }

  protected handlers = {
    [systemResourcesCapabilities.testId]: this.capabilities.bind(this),
    [systemResourcesSample.testId]: this.sample.bind(this),
    [systemResourcesInvalidInput.testId]: this.invalidInput.bind(this)
  }

  async capabilities(
    params: typeof systemResourcesCapabilities.params,
    expectation: Expectation
  ): Promise<TestResult> {
    const resources = await getSystemResources(params)
    assertCapabilities(resources)
    if (resources.sample) throw new Error('Sample returned when it was not requested')
    return ValidationHelpers.validate('capabilities valid; sample omitted', expectation)
  }

  async sample(
    params: typeof systemResourcesSample.params,
    expectation: Expectation
  ): Promise<TestResult> {
    const resources = await getSystemResources(params)
    assertCapabilities(resources)
    const memory = assertSample(resources)
    assertProcessMemory(memory, this.#platform)

    return ValidationHelpers.validate(
      `capabilities valid; sample valid; process used=${describeMetric(memory.processUsedBytes)} available=${describeMetric(memory.processAvailableBytes)}; system used=${describeMetric(memory.usedBytes)} total=${describeMetric(memory.totalBytes)}`,
      expectation
    )
  }

  async invalidInput(
    params: typeof systemResourcesInvalidInput.params,
    expectation: Expectation
  ): Promise<TestResult> {
    try {
      await getSystemResources(params as never)
      return {
        passed: false,
        output: 'Invalid sample input was accepted'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const passed =
        expectation.validation === 'throws-error' && message.includes(expectation.errorContains)
      return {
        passed,
        output: passed ? `Correctly threw: ${message}` : `Unexpected error: ${message}`
      }
    }
  }
}
