import { getSystemResources, type ResourceMetric } from '@qvac/sdk'

// Zod-inferred responses permit an explicit undefined reason with exactOptionalPropertyTypes.
type Metric<T> =
  | ResourceMetric<T>
  | {
      status: 'unavailable' | 'unverified' | 'failed'
      reason?: string | undefined
    }

function formatBytes(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function formatUtilization(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function printMetric<T>(
  label: string,
  metric: Metric<T>,
  format: (value: T) => string,
  indent = '  '
) {
  if (metric.status === 'supported') {
    const scope = metric.provenance.scope ? `/${metric.provenance.scope}` : ''
    console.log(`${indent}${label}: ${format(metric.value)} (${metric.provenance.source}${scope})`)
    return
  }

  const reason = metric.reason ? ` — ${metric.reason}` : ''
  console.log(`${indent}${label}: ${metric.status}${reason}`)
}

try {
  // sample: true performs fresh usage queries, so request it only when current usage is needed.
  const resources = await getSystemResources({ sample: true })
  const { capabilities, sample } = resources

  console.log('▸ CPU')
  if (capabilities.cpu.status === 'supported') {
    const cpu = capabilities.cpu.value
    printMetric('Name', cpu.name, String)
    printMetric('Physical cores', cpu.physicalCores, String)
    printMetric('Logical cores', cpu.logicalCores, String)
  } else {
    printMetric('Capabilities', capabilities.cpu, String)
  }

  console.log('\n▸ Memory')
  printMetric('Total', capabilities.memory.totalBytes, formatBytes)
  if (sample) {
    printMetric('Used', sample.memory.usedBytes, formatBytes)
    printMetric('Total (sampled)', sample.memory.totalBytes, formatBytes)
    printMetric('Process used', sample.memory.processUsedBytes, formatBytes)
    printMetric('Process available', sample.memory.processAvailableBytes, formatBytes)
  }

  console.log('\n▸ GPUs')
  const gpuLabels = new Map<string, string>()
  if (capabilities.gpus.status === 'supported') {
    if (capabilities.gpus.value.length === 0) {
      console.log('  No GPUs enumerated.')
    }
    for (const [index, gpu] of capabilities.gpus.value.entries()) {
      const label =
        gpu.name.status === 'supported'
          ? `${gpu.name.value} (GPU ${index + 1})`
          : `GPU ${index + 1}`
      gpuLabels.set(gpu.id, label)
      console.log(`  ${label}`)
      console.log(`    ID: ${gpu.id}`)
      printMetric('Vendor', gpu.vendor, String, '    ')
      printMetric('Total memory', gpu.memoryTotalBytes, formatBytes, '    ')
      const drivers = Object.entries(gpu.drivers)
        .filter(([, metric]) => metric.status === 'supported' && metric.value)
        .map(([driver]) => driver)
      console.log(`    Graphics APIs: ${drivers.join(', ') || 'none reported'}`)
    }
  } else {
    printMetric('Capabilities', capabilities.gpus, String)
  }

  if (sample) {
    console.log('\n▸ Live utilization')
    printMetric('CPU', sample.cpu, formatUtilization)
    if (sample.gpus.status === 'supported') {
      if (sample.gpus.value.length === 0) {
        console.log('  No GPU samples reported.')
      }
      for (const [index, gpu] of sample.gpus.value.entries()) {
        const label = gpuLabels.get(gpu.id) ?? `GPU ${index + 1}`
        console.log(`  ${label}`)
        console.log(`    ID: ${gpu.id}`)
        printMetric('Compute', gpu.compute, formatUtilization, '    ')
        printMetric('Memory used', gpu.memoryUsedBytes, formatBytes, '    ')
      }
    } else {
      printMetric('GPU samples', sample.gpus, String)
    }
  }

  console.log('\n▸ Resource diagnostics do not reserve memory or guarantee model fit.')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
