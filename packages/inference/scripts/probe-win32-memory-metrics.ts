// Windows memory-counter probe for the assessModelFit calibration harness.
//
// Loads calibration models at two contexts under two load modes and reports,
// per load, what three per-process counters observe: libuv's rss (which on
// win32 is GetProcessMemoryInfo().WorkingSetSize) and, via PowerShell for the
// same pid, WorkingSet64 and PrivateMemorySize64 (the commit charge). The KV
// cache is computed exactly from the GGUF facts, so the difference between the
// two contexts is a known quantity of anonymous memory a sound counter must see.
//
// Experiment only — not part of the harness. Run from the package root on a
// Windows host after `npm run build`:
//
//   node node_modules/bare/bin/bare scripts/probe-win32-memory-metrics.ts

import os from 'bare-os'
import { spawnSync } from 'bare-subprocess'
import { registerPlugin, loadModel, completion, unloadModel } from '../dist/index.js'
import * as catalog from '../dist/models/registry/index.js'
import { MODEL_RESOURCE_PROFILES } from '../dist/models/registry/resource-profiles.js'
import { kvCacheBytesForWidth } from '../dist/resources/model-fit/estimators/llm.js'
import { llmPlugin } from '../dist/plugins/builtin/llamacpp-completion/plugin.js'

declare const Bare: { argv: string[]; exit(code?: number): never }

const MODELS = ['QWEN3_600M_INST_Q4', 'QWEN3_4B_INST_Q4_K_M']
const CONTEXTS = [512, 8192]
const LOAD_MODES = ['mmap', 'none'] as const
const REPEATS = 2
const SETTLE_MS = 250
const F16_BYTES = 2

interface Counters {
  rss: number
  workingSet: number
  privateBytes: number
  virtualBytes: number
}

let reads = 0

function readCounters(): Counters {
  const rss = os.memoryUsage().rss
  const script = `$p = Get-Process -Id ${os.pid()}; Write-Output ($p.WorkingSet64, $p.PrivateMemorySize64, $p.VirtualMemorySize64 -join ' ')`
  // powershell.exe waits for EOF on a redirected stdin before it exits, so
  // stdin must be closed (ignored) and input parsing disabled, or the first
  // read hangs the run.
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', script],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      `powershell exited ${result.status}: ${result.stderr ? result.stderr.toString() : ''}`
    )
  }
  const [workingSet, privateBytes, virtualBytes] = result.stdout
    .toString()
    .trim()
    .split(/\s+/)
    .map(Number)
  reads += 1
  console.log(
    `    read ${reads}: rss(uv) ${mib(rss)} MiB, ws(ps) ${mib(workingSet!)} MiB, private ${mib(privateBytes!)} MiB`
  )
  return { rss, workingSet: workingSet!, privateBytes: privateBytes!, virtualBytes: virtualBytes! }
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

const mib = (n: number) => (n / 1024 / 1024).toFixed(0)

function delta(after: Counters, before: Counters) {
  return {
    rss: after.rss - before.rss,
    workingSet: after.workingSet - before.workingSet,
    privateBytes: after.privateBytes - before.privateBytes,
    virtualBytes: after.virtualBytes - before.virtualBytes
  }
}

function fmt(d: ReturnType<typeof delta>) {
  return `rss(uv) ${mib(d.rss)} MiB, ws(ps) ${mib(d.workingSet)} MiB, private ${mib(d.privateBytes)} MiB, virtual ${mib(d.virtualBytes)} MiB`
}

interface Point {
  name: string
  loadMode: string
  contextTokens: number
  artifactBytes: number
  kvBytes: number
  afterLoad: ReturnType<typeof delta>
  afterCompletion: ReturnType<typeof delta>
}

async function measure(name: string, contextTokens: number, loadMode: string): Promise<Point> {
  const model = (catalog as Record<string, { sha256Checksum: string } | undefined>)[name]
  if (!model) throw new Error(`unknown catalog constant: ${name}`)
  const profile = MODEL_RESOURCE_PROFILES[model.sha256Checksum]
  if (!profile?.ggufFacts) throw new Error(`no GGUF facts for ${name}`)
  const kv = kvCacheBytesForWidth(profile.ggufFacts, contextTokens, F16_BYTES)

  await settle()
  const before = readCounters()

  const modelId = await loadModel({
    modelSrc: model,
    modelConfig: { ctx_size: contextTokens, gpu_layers: 0, load_mode: loadMode }
  })

  await settle()
  const afterLoad = readCounters()

  const result = completion({
    modelId,
    history: [{ role: 'user', content: 'Summarize the history of cartography.' }],
    stream: false,
    params: { maxTokens: 128 }
  })
  await result.response
  const afterCompletion = readCounters()

  await unloadModel({ modelId })
  await settle()

  return {
    name,
    loadMode,
    contextTokens,
    artifactBytes: profile.artifactBytes,
    kvBytes: kv.lower,
    afterLoad: delta(afterLoad, before),
    afterCompletion: delta(afterCompletion, before)
  }
}

async function main() {
  console.log(`probing ${os.platform()}-${os.arch()} pid ${os.pid()}`)
  console.log('baseline:', JSON.stringify(readCounters()))

  registerPlugin(llmPlugin)

  const points: Point[] = []
  for (const name of MODELS) {
    for (const loadMode of LOAD_MODES) {
      for (const contextTokens of CONTEXTS) {
        for (let repeat = 0; repeat < REPEATS; repeat++) {
          const point = await measure(name, contextTokens, loadMode)
          points.push(point)
          console.log(
            `  ${name} @ ${contextTokens} load_mode=${loadMode} (${repeat + 1}/${REPEATS}): artifact ${mib(point.artifactBytes)} MiB, kv ${mib(point.kvBytes)} MiB`
          )
          console.log(`    after load:       ${fmt(point.afterLoad)}`)
          console.log(`    after completion: ${fmt(point.afterCompletion)}`)
        }
      }
    }
  }

  // The KV cache is the one anonymous allocation whose size the file states
  // exactly, so the gap between the two contexts is the ground truth each
  // counter is judged against.
  console.log('\nKV ground truth — mean delta between contexts, after load:')
  for (const name of MODELS) {
    for (const loadMode of LOAD_MODES) {
      const at = (ctx: number) =>
        points.filter((p) => p.name === name && p.loadMode === loadMode && p.contextTokens === ctx)
      const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
      const lo = at(CONTEXTS[0]!)
      const hi = at(CONTEXTS[1]!)
      const kvDelta = hi[0]!.kvBytes - lo[0]!.kvBytes
      const rss = mean(hi.map((p) => p.afterLoad.rss)) - mean(lo.map((p) => p.afterLoad.rss))
      const ws =
        mean(hi.map((p) => p.afterLoad.workingSet)) - mean(lo.map((p) => p.afterLoad.workingSet))
      const priv =
        mean(hi.map((p) => p.afterLoad.privateBytes)) -
        mean(lo.map((p) => p.afterLoad.privateBytes))
      const pct = (v: number) => `${((v / kvDelta) * 100).toFixed(0)}%`
      console.log(
        `  ${name} load_mode=${loadMode}: kv delta ${mib(kvDelta)} MiB — rss(uv) ${mib(rss)} MiB (${pct(rss)}), ws(ps) ${mib(ws)} MiB (${pct(ws)}), private ${mib(priv)} MiB (${pct(priv)})`
      )
    }
  }

  console.log('\nWeights — mean after-load delta at the small context vs artifact size:')
  for (const name of MODELS) {
    for (const loadMode of LOAD_MODES) {
      const lo = points.filter(
        (p) => p.name === name && p.loadMode === loadMode && p.contextTokens === CONTEXTS[0]
      )
      const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
      const artifact = lo[0]!.artifactBytes
      const kv = lo[0]!.kvBytes
      const rss = mean(lo.map((p) => p.afterLoad.rss)) - kv
      const priv = mean(lo.map((p) => p.afterLoad.privateBytes)) - kv
      console.log(
        `  ${name} load_mode=${loadMode}: artifact ${mib(artifact)} MiB — rss(uv) minus kv ${mib(rss)} MiB, private minus kv ${mib(priv)} MiB`
      )
    }
  }
}

main()
  .then(() => {
    // The first run printed its summary and then never exited (an engine
    // handle keeps the loop alive), holding the runner until the job was
    // cancelled.
    Bare.exit(0)
  })
  .catch((error) => {
    console.error('probe failed:', error)
    Bare.exit(1)
  })
