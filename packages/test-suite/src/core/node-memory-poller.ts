import { execSync } from 'node:child_process'
import type { MqttClient } from 'mqtt'

/**
 * Node runtime in-app memory poller.
 *
 * Walks the consumer process tree (parent + Bare worker + any other children)
 * via a single `ps -A` fork per tick, sums RSS in KB, and publishes the result
 * on `qvac/app-memory` so the orchestrator can append it to `app-mem.ndjson`
 * just like the mobile in-app poller does. This is shared by desktop and
 * Electron consumers because both run the SDK from a Node-compatible process.
 *
 * Tree-walking matters: the QVAC SDK runs inference inside a Bare worker that
 * lives in a child process, so `process.memoryUsage().rss` on the parent
 * misses the bulk of memory usage. `ps -A -o pid=,ppid=,rss=` lets us do that
 * in one fork instead of N pgrep + ps roundtrips.
 *
 * Publish rate defaults to 5 Hz (200 ms). Override via:
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

const DEFAULT_INTERVAL_MS = 200

export function startNodeMemoryPoller(
  opts: NodeMemoryPollerOptions
): NodeMemoryPollerHandle | null {
  if (process.env.QVAC_NODE_MEM_DISABLED === '1' || process.env.QVAC_DESKTOP_MEM_DISABLED === '1') {
    return null
  }

  const configuredInterval =
    process.env.QVAC_NODE_MEM_INTERVAL_MS ||
    process.env.QVAC_DESKTOP_MEM_INTERVAL_MS ||
    String(DEFAULT_INTERVAL_MS)
  const intervalMs = opts.intervalMs ?? Number(configuredInterval)
  const rootPid = opts.rootPid ?? process.pid
  const platform = opts.platform ?? 'node'

  let stopped = false

  const tick = () => {
    if (stopped) return
    const rssKb = collectTreeRssKb(rootPid)
    if (rssKb === null) return
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
    } catch {
      // best-effort; never throw from the timer
    }
  }

  const handle = setInterval(tick, intervalMs)
  // Don't keep the event loop alive just for the poller.
  handle.unref?.()

  return {
    stop: () => {
      stopped = true
      clearInterval(handle)
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
function collectTreeRssKb(rootPid: number): number | null {
  let raw: string
  try {
    raw = execSync('ps -A -o pid=,ppid=,rss=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }

  // Build pid -> { ppid, rss } and a ppid -> children index in one pass.
  const byPid = new Map<number, { ppid: number; rss: number }>()
  const childrenOf = new Map<number, number[]>()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const rss = Number(parts[2])
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rss)) continue
    byPid.set(pid, { ppid, rss })
    const list = childrenOf.get(ppid)
    if (list) list.push(pid)
    else childrenOf.set(ppid, [pid])
  }

  if (!byPid.has(rootPid)) return null

  const seen = new Set<number>()
  const queue: number[] = [rootPid]
  let total = 0
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (seen.has(cur)) continue
    seen.add(cur)
    const entry = byPid.get(cur)
    if (entry) total += entry.rss
    const kids = childrenOf.get(cur)
    if (kids) {
      for (const k of kids) {
        if (!seen.has(k)) queue.push(k)
      }
    }
  }

  return total > 0 ? total : null
}
