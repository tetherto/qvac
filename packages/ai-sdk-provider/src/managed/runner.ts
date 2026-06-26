import { rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { RUNNER_POLL_INTERVAL_MS } from '../defaults.js'
import {
  ensureDirSync,
  liveConsumers,
  managedServesDir,
  removeRecord,
  writeRecordSync
} from './registry.js'
import { spawnServe, stopServe } from './serve-process.js'
import type { SpawnedServe } from './serve-process.js'

// The detached runner. The client spawns one of these (unref'd, stdio ignored)
// to *own* a shared `qvac serve`: it starts the serve, publishes the registry
// record, then keeps the serve alive exactly as long as some consumer process
// is using it. When no consumer has been alive for `idleTimeoutMs`, it stops
// the serve and exits — guaranteeing cleanup even after every client has gone,
// without any client needing to stay resident.

export interface RunnerParams {
  readonly fleetKey: string
  readonly configPath: string
  readonly port: number
  readonly host: string
  readonly idleTimeoutMs: number
  readonly startTimeoutMs: number
  readonly serveBinPath?: string
}

function errorPath(fleetKey: string): string {
  return join(managedServesDir(), `${fleetKey}.error`)
}

// Pure idle decision, factored out for unit testing. `emptySince` is the
// timestamp the consumer set first became empty (null while someone is using
// the serve). Returns the updated `emptySince` and whether to reap now.
export function decideReap(params: {
  liveConsumerCount: number
  emptySince: number | null
  now: number
  idleTimeoutMs: number
}): { emptySince: number | null; reap: boolean } {
  const { liveConsumerCount, now, idleTimeoutMs } = params
  if (liveConsumerCount > 0) return { emptySince: null, reap: false }
  const emptySince = params.emptySince ?? now
  return { emptySince, reap: now - emptySince >= idleTimeoutMs }
}

function cleanup(fleetKey: string, configPath: string): void {
  removeRecord(fleetKey)
  if (configPath.length > 0) {
    try {
      rmSync(dirname(configPath), { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}

export async function runRunner(params: RunnerParams): Promise<void> {
  const { fleetKey, configPath, port, host, idleTimeoutMs, startTimeoutMs } = params

  ensureDirSync()

  let spawned: SpawnedServe
  try {
    spawned = await spawnServe({
      configPath,
      port,
      host,
      startTimeoutMs,
      ...(params.serveBinPath !== undefined ? { serveBinPath: params.serveBinPath } : {})
    })
  } catch (err) {
    // Publish the failure so the waiting client can surface it instead of just
    // timing out, then leave the config dir for the client to inspect/clean.
    try {
      writeFileSync(errorPath(fleetKey), String((err as Error).message ?? err), 'utf8')
    } catch {
      // best-effort
    }
    cleanup(fleetKey, configPath)
    process.exit(1)
  }

  const servePid = spawned.pid

  writeRecordSync({
    fleetKey,
    servePid,
    runnerPid: process.pid,
    port,
    host,
    baseURL: spawned.baseURL,
    configPath,
    startedAt: new Date().toISOString(),
    idleTimeoutMs
  })

  let shuttingDown = false
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    await stopServe(spawned.child).catch(() => {})
    cleanup(fleetKey, configPath)
    process.exit(code)
  }

  // If the serve dies on its own, there is nothing left to own — clean up the
  // record so the next client spawns fresh instead of attaching to a corpse.
  // (During a deliberate shutdown this is a no-op: `shutdown` owns the exit.)
  spawned.child.once('exit', () => {
    if (shuttingDown) return
    cleanup(fleetKey, configPath)
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    void shutdown(143)
  })
  process.on('SIGINT', () => {
    void shutdown(130)
  })

  // Idle-reaping loop, driven entirely by consumer-process liveness so it works
  // for any client regardless of how it sends requests (it never inspects the
  // serve's traffic). The spawning client registers itself as a consumer before
  // launching us, so the set is non-empty by the time this first ticks.
  let emptySince: number | null = null

  const timer = setInterval(() => {
    void (async () => {
      let count: number
      try {
        count = (await liveConsumers(fleetKey)).length
      } catch {
        return // transient FS error — re-check next tick
      }
      const decision = decideReap({
        liveConsumerCount: count,
        emptySince,
        now: Date.now(),
        idleTimeoutMs
      })
      emptySince = decision.emptySince
      if (decision.reap) {
        clearInterval(timer)
        await shutdown(0)
      }
    })()
  }, RUNNER_POLL_INTERVAL_MS)
  // Don't let the idle timer itself keep the event loop alive beyond the serve.
  timer.unref()
}

function parseArgs(argv: string[]): RunnerParams {
  return JSON.parse(argv[2] ?? '{}') as RunnerParams
}

// Run only when invoked as a script (the spawned subprocess), not when imported
// by the client or a test.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  void runRunner(parseArgs(process.argv))
}

// Resolve the runner module's own path + the command needed to execute it,
// transparently handling both compiled (`dist/.../runner.js` under Node) and
// dev (`src/.../runner.ts` under tsx) layouts so the client can spawn us.
export function runnerSpawnSpec(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url)
  if (!here.endsWith('.ts')) {
    // Production: a compiled `.js` runs directly under Node.
    return { command: process.execPath, args: [here] }
  }
  // Dev/test: run the `.ts` through tsx's CLI. We invoke the resolved CLI entry
  // via `node <tsx-cli> <runner.ts>` rather than `node --import tsx` so it works
  // on every Node 20.x (`--import` needs 20.6+); tsx is a dev-only dependency.
  const require = createRequire(import.meta.url)
  const pkgJson = require.resolve('tsx/package.json')
  const pkg = require(pkgJson) as { bin?: string | Record<string, string> }
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['tsx']
  if (binRel === undefined) throw new Error('Unable to resolve tsx CLI for managed-mode dev runner')
  return { command: process.execPath, args: [join(dirname(pkgJson), binRel), here] }
}
