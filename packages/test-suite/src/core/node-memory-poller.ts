import { execSync } from 'node:child_process'
import type { MqttClient } from 'mqtt'
import { parseProcessRssTable, sumProcessTreeRssKb } from './process-tree-rss.js'
import { WindowsRssCollector } from './windows-rss-collector.js'

/**
 * Node runtime in-app memory poller.
 *
 * Walks the consumer process tree (parent + Bare worker + any other children),
 * sums RSS in KB, and publishes the result on `qvac/app-memory` so the
 * orchestrator can append it to `app-mem.ndjson` just like the mobile in-app
 * poller does. Shared by desktop and Electron consumers because both run the
 * SDK from a Node-compatible process.
 *
 * Tree-walking matters: the QVAC SDK runs inference inside a Bare worker that
 * lives in a child process, so `process.memoryUsage().rss` on the parent
 * misses the bulk of memory usage.
 *
 * POSIX uses a single `ps -A -o pid=,ppid=,rss=` fork per tick. Windows keeps
 * one PowerShell/CIM collector alive and requests snapshots over stdin/stdout
 * so we do not pay a PowerShell cold-start on every tick.
 *
 * Publish rate defaults to 5 Hz (200 ms) on POSIX and 2 Hz (500 ms) on
 * Windows. Override via:
 *   QVAC_NODE_MEM_INTERVAL_MS     — tick period in ms
 *   QVAC_NODE_MEM_DISABLED=1      — turn the poller off entirely
 *
 * The older QVAC_DESKTOP_MEM_* environment variables remain supported for
 * existing desktop setups.
 */

export interface NodeMemoryPollerOptions {
  client: MqttClient
  runId: string
  consumerId: string
  intervalMs?: number
  /** Platform label to write into app-mem.ndjson. Defaults to "node". */
  platform?: string
  /** Process to use as the tree root. Defaults to the current process. */
  rootPid?: number
}

export interface NodeMemoryPollerHandle {
  stop: () => void
}

const DEFAULT_POSIX_INTERVAL_MS = 200
const DEFAULT_WINDOWS_INTERVAL_MS = 500

function defaultIntervalMs(): number {
  return process.platform === 'win32' ? DEFAULT_WINDOWS_INTERVAL_MS : DEFAULT_POSIX_INTERVAL_MS
}

function logMem(message: string): void {
  console.warn(`[node-mem] ${message}`)
}

export function startNodeMemoryPoller(
  opts: NodeMemoryPollerOptions
): NodeMemoryPollerHandle | null {
  if (process.env.QVAC_NODE_MEM_DISABLED === '1' || process.env.QVAC_DESKTOP_MEM_DISABLED === '1') {
    return null
  }

  const configuredInterval =
    process.env.QVAC_NODE_MEM_INTERVAL_MS ||
    process.env.QVAC_DESKTOP_MEM_INTERVAL_MS ||
    String(defaultIntervalMs())
  const intervalMs = opts.intervalMs ?? Number(configuredInterval)
  const rootPid = opts.rootPid ?? process.pid
  const platform = opts.platform ?? 'node'
  const collectorName = process.platform === 'win32' ? 'powershell-cim' : 'ps'
  const windowsCollector = process.platform === 'win32' ? new WindowsRssCollector() : null

  if (windowsCollector) windowsCollector.start()

  console.log(
    `[node-mem] started collector=${collectorName} interval=${intervalMs}ms rootPid=${rootPid} platform=${platform}`
  )

  let stopped = false
  let inflight = false
  let consecutiveFailures = 0

  const publish = (rssKb: number) => {
    const sample = {
      ts: Date.now(),
      pid: rootPid,
      memoryKb: rssKb,
      metric: 'rss',
      platform,
      runId: opts.runId,
      consumerId: opts.consumerId
    }
    try {
      opts.client.publish('qvac/app-memory', JSON.stringify(sample), { qos: 0 })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      logMem(`failed to publish qvac/app-memory sample: ${message}`)
    }
  }

  const noteFailure = (detail?: string) => {
    consecutiveFailures++
    if (consecutiveFailures === 1 || consecutiveFailures % 25 === 0) {
      logMem(
        detail
          ? `failed to collect process-tree RSS (x${consecutiveFailures}): ${detail}`
          : `failed to collect process-tree RSS (x${consecutiveFailures})`
      )
    }
  }

  const tick = async () => {
    if (stopped || inflight) return
    inflight = true
    try {
      const rssKb = windowsCollector
        ? await windowsCollector.collectTreeRssKb(rootPid)
        : collectPosixTreeRssKb(rootPid)
      if (rssKb === null) {
        noteFailure(
          windowsCollector ? 'empty or missing windows snapshot' : 'empty or missing ps snapshot'
        )
        return
      }
      consecutiveFailures = 0
      publish(rssKb)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      noteFailure(message)
    } finally {
      inflight = false
    }
  }

  const handle = setInterval(() => {
    void tick()
  }, intervalMs)
  // Don't keep the event loop alive just for the poller.
  handle.unref?.()

  return {
    stop: () => {
      stopped = true
      clearInterval(handle)
      windowsCollector?.stop()
    }
  }
}

export type DesktopMemoryPollerOptions = NodeMemoryPollerOptions
export type DesktopMemoryPollerHandle = NodeMemoryPollerHandle

export function startDesktopMemoryPoller(
  opts: DesktopMemoryPollerOptions
): DesktopMemoryPollerHandle | null {
  return startNodeMemoryPoller({ ...opts, platform: opts.platform ?? 'desktop' })
}

/**
 * Single `ps -A` fork that returns rss-kb for every process, then we walk
 * the tree from rootPid client-side. Returns null on any failure -- the
 * poller treats that as a missed tick rather than crashing.
 */
function collectPosixTreeRssKb(rootPid: number): number | null {
  let raw: string
  try {
    raw = execSync('ps -A -o pid=,ppid=,rss=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error: unknown) {
    const err = error as { stderr?: string | Buffer; message?: string }
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf8')
    const detail = stderr?.trim() || err.message || 'ps failed'
    logMem(`ps collector failed: ${detail}`)
    return null
  }

  return sumProcessTreeRssKb(parseProcessRssTable(raw), rootPid)
}
