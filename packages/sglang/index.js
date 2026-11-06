import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

const valueFlags = [
  ['model', '--model'],
  ['artifacts', '--artifacts'],
  ['host', '--host'],
  ['port', '--port'],
  ['maxConnections', '--max-connections'],
  ['tpSize', '--tp-size'],
  ['epSize', '--ep-size'],
  ['dpSize', '--dp-size'],
  ['ppSize', '--pp-size'],
  ['cpSize', '--cp-size'],
  ['contextLength', '--context-length'],
  ['maxTotalTokens', '--max-total-tokens'],
  ['maxRunningRequests', '--max-running-requests'],
  ['maxPrefillTokens', '--max-prefill-tokens'],
  ['memFractionStatic', '--mem-fraction-static'],
  ['cudaGraphBatchSizes', '--cuda-graph-batch-sizes'],
  ['cachePolicy', '--cache-policy'],
  ['maxHttpRequests', '--max-http-requests'],
  ['maxRequestBytes', '--max-request-bytes'],
  ['apiKey', '--api-key'],
  ['corsAllowOrigin', '--cors-allow-origin'],
  ['queueTimeout', '--queue-timeout'],
  ['requestTimeout', '--request-timeout'],
  ['streamIdleTimeout', '--stream-idle-timeout']
]

export function serverBinary() {
  return path.join(packageRoot, 'dist', 'bin', 'qvac_grid_server')
}

export function rankWorkerBinary() {
  return path.join(packageRoot, 'dist', 'bin', 'qvac_grid_rank_worker')
}

export function artifactRoot() {
  return path.join(packageRoot, 'dist', 'lib', 'qvac-grid')
}

export function compileSidecar() {
  return path.join(
    packageRoot,
    'dist',
    'share',
    'qvac-grid',
    'tools',
    'aot',
    'triton_compile_sidecar.py'
  )
}

export function serverArgs(options = {}) {
  const args = []
  const values = { ...options, artifacts: options.artifacts ?? artifactRoot() }
  for (const [key, flag] of valueFlags) {
    const value = values[key]
    if (value == null || value === '') continue
    args.push(flag, String(value))
  }
  if (options.cudaGraph === false) args.push('--disable-cuda-graph')
  if (options.extraArgs?.length) args.push(...options.extraArgs)
  return args
}

export function startServer(options = {}) {
  if (!options.model) {
    throw new Error('startServer requires options.model')
  }
  const binary = serverBinary()
  if (!fs.existsSync(binary)) {
    throw new Error(`SGLang server is not staged at ${binary}. Run pnpm build in packages/sglang.`)
  }
  const artifacts = options.artifacts ?? artifactRoot()
  if (options.artifacts == null && !fs.existsSync(artifacts)) {
    throw new Error(`SGLang artifact package is not staged at ${artifacts}.`)
  }
  const env = { ...process.env }
  if (!env.QVAC_GRID_RANK_WORKER) env.QVAC_GRID_RANK_WORKER = rankWorkerBinary()
  if (!env.QVAC_GRID_TRITON_COMPILE_SCRIPT) env.QVAC_GRID_TRITON_COMPILE_SCRIPT = compileSidecar()
  return spawn(binary, serverArgs({ ...options, artifacts }), {
    stdio: options.stdio ?? 'inherit',
    env
  })
}
