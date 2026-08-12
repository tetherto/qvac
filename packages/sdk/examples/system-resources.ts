import { getSystemResources } from '@qvac/sdk'
import type { ResourceMetric } from '@qvac/sdk'

type PrintableMetric<T> =
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

function printMetric<T>(label: string, metric: PrintableMetric<T>, format: (value: T) => string) {
  if (metric.status === 'supported') {
    console.log(`▸ ${label}: ${format(metric.value)}`)
    return
  }

  const reason = metric.reason ? ` — ${metric.reason}` : ''
  console.log(`▸ ${label}: ${metric.status}${reason}`)
}

try {
  const resources = await getSystemResources({ sample: true })
  const { capabilities, sample } = resources

  console.log('▸ CPU')
  if (capabilities.cpu.status === 'supported') {
    const cpu = capabilities.cpu.value
    printMetric('Name', cpu.name, String)
    printMetric('Architecture', cpu.architecture, String)
    printMetric('Physical cores', cpu.physicalCores, String)
    printMetric('Logical cores', cpu.logicalCores, String)
  } else {
    console.log(`▸ CPU capabilities: ${capabilities.cpu.status}`)
  }

  console.log('\n▸ Memory')
  printMetric('Total', capabilities.memory.totalBytes, formatBytes)
  if (sample) {
    printMetric('Used', sample.memory.usedBytes, formatBytes)
    printMetric('Current total', sample.memory.totalBytes, formatBytes)
  }

  console.log('\n▸ GPUs')
  if (capabilities.gpus.status === 'supported' && capabilities.gpus.value.length > 0) {
    for (const gpu of capabilities.gpus.value) {
      console.log(`▸ GPU ${gpu.id}`)
      printMetric('Name', gpu.name, String)
      printMetric('Vendor', gpu.vendor, String)
      printMetric('Total memory', gpu.memoryTotalBytes, formatBytes)
      const drivers = Object.entries(gpu.drivers)
        .filter(([, metric]) => metric.status === 'supported' && metric.value)
        .map(([driver]) => driver)
      console.log(`▸ Graphics APIs: ${drivers.join(', ') || 'none reported'}`)
    }
  } else {
    console.log(`▸ GPU capabilities: ${capabilities.gpus.status}`)
  }

  if (sample) {
    console.log('\n▸ Live utilization')
    printMetric('CPU', sample.cpu, formatUtilization)
    if (sample.gpus.status === 'supported') {
      for (const gpu of sample.gpus.value) {
        printMetric(`GPU ${gpu.id} compute`, gpu.compute, formatUtilization)
        printMetric(`GPU ${gpu.id} memory used`, gpu.memoryUsedBytes, formatBytes)
      }
    } else {
      console.log(`▸ GPU samples: ${sample.gpus.status}`)
    }
  }

  console.log('\n▸ Resource diagnostics do not reserve memory or guarantee model fit.')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
