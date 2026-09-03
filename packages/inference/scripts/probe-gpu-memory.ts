// Probe: is bare-gpu-info's memory reading usable as a VRAM admission budget?
//
// `collector.ts` stamps every GPU memory value `unverified` because the native
// API does not say whether it is device memory, a Windows process budget, or an
// Apple process-local allocation. This asks the hardware directly:
//
//   1. what the totals look like against the runner's known GPU, and
//   2. whether `memoryUsed` moves by the model size when a model is loaded onto
//      the GPU — a counter that does not track a real allocation cannot bound
//      one.
//
// Experiment only, not for merge.
//
//   npm run build
//   bare scripts/probe-gpu-memory.ts

import os from 'bare-os'
import GPUInfo from 'bare-gpu-info'
import { registerPlugin, loadModel, unloadModel, getSystemResources } from '../dist/index.js'
import * as catalog from '../dist/models/registry/index.js'
import { MODEL_RESOURCE_PROFILES } from '../dist/models/registry/resource-profiles.js'
import { llmPlugin } from '../dist/plugins/builtin/llamacpp-completion/plugin.js'

declare const Bare: { argv: string[]; exit(code?: number): never }

const MODEL = 'QWEN3_4B_INST_Q4_K_M'
const CONTEXT = 512

function mib(n: number | undefined) {
  return n === undefined || n === null ? 'undefined' : `${(n / 1024 / 1024).toFixed(0)} MiB`
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 500))
}

function sampleAll(info: InstanceType<typeof GPUInfo>) {
  const out: { used: number | undefined; total: number | undefined }[] = []
  for (let i = 0; i < info.length; i++) {
    const usage = info.sample(i)
    out.push({ used: usage.memoryUsed, total: usage.memoryTotal })
  }
  return out
}

async function main() {
  const platform = `${os.platform()}-${os.arch()}`
  console.log(`gpu-memory probe on ${platform}`)
  console.log(`system RAM total: ${mib(os.totalmem())}`)

  const info = new GPUInfo()
  console.log(`\ngpu inventory (${info.length}):`)
  for (let i = 0; i < info.length; i++) {
    const gpu = info.gpu(i)
    const drivers = Object.entries(gpu.drivers)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(',')
    console.log(
      `  [${i}] ${gpu.name} (${gpu.vendor}) type=${gpu.type} unified=${gpu.unifiedMemory}`
    )
    console.log(`      capabilities.memory = ${mib(gpu.memory)}  drivers=${drivers}`)
  }

  registerPlugin(llmPlugin)

  // How the SDK currently grades those same numbers.
  const resources = await getSystemResources()
  const gpus = resources.capabilities.gpus
  console.log(`\nSDK capabilities.gpus status: ${gpus.status}`)
  if (gpus.status === 'supported') {
    for (const gpu of gpus.value) {
      console.log(`  memoryTotalBytes status: ${gpu.memoryTotalBytes.status}`)
    }
  }

  const before = sampleAll(info)
  console.log('\nbaseline sample:')
  before.forEach((s, i) => console.log(`  [${i}] used=${mib(s.used)} total=${mib(s.total)}`))

  // Load onto the GPU — the SDK default, no device override.
  const model = (catalog as Record<string, { sha256Checksum: string } | undefined>)[MODEL]
  if (!model) throw new Error(`unknown catalog constant: ${MODEL}`)
  const profile = MODEL_RESOURCE_PROFILES[model.sha256Checksum]
  console.log(`\nloading ${MODEL} (artifact ${mib(profile?.artifactBytes)}) at ctx ${CONTEXT}`)

  const rssBefore = os.memoryUsage().rss
  const modelId = await loadModel({ modelSrc: model, modelConfig: { ctx_size: CONTEXT } })
  await settle()
  const rssAfter = os.memoryUsage().rss

  const after = sampleAll(info)
  console.log('\nafter load:')
  after.forEach((s, i) => {
    const delta =
      s.used !== undefined && before[i]?.used !== undefined ? s.used - before[i]!.used : undefined
    console.log(`  [${i}] used=${mib(s.used)} total=${mib(s.total)} delta=${mib(delta)}`)
  })
  console.log(`  process RSS delta: ${mib(rssAfter - rssBefore)}`)

  await unloadModel({ modelId })
  await settle()
  const unloaded = sampleAll(info)
  console.log('\nafter unload:')
  unloaded.forEach((s, i) => console.log(`  [${i}] used=${mib(s.used)} total=${mib(s.total)}`))

  console.log(
    '\nreading: a device-scoped counter shows total matching the card and a used delta near the artifact size; a value that tracks system RAM, stays flat, or mirrors RSS is not a VRAM budget.'
  )

  info.destroy()
  Bare.exit(0)
}

main().catch((error) => {
  console.error('probe failed:', error)
  Bare.exit(1)
})
