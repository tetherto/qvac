import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// Shared, cross-process registry of managed serves. Each running serve is
// described by one record keyed by its *fleet key* (model set + config + host),
// so any session that would launch an identical serve discovers and reuses it
// instead of spawning a duplicate. Consumers (the processes that asked for the
// serve) are tracked as marker files so a detached runner can keep the serve
// alive while anyone is using it and reap it once everyone is gone.
//
// Layout under ~/.qvac/managed-serves/:
//   <fleetKey>.json            the ServeRecord
//   <fleetKey>.consumers/<pid> one empty marker file per live consumer process
//   <fleetKey>.lock            transient spawn lock (see client)
export function managedServesDir(): string {
  return join(homedir(), '.qvac', 'managed-serves')
}

export interface ServeRecord {
  readonly fleetKey: string
  // PID of the `qvac serve` process (what callers see as provider.pid).
  readonly servePid: number
  // PID of the detached runner that owns the serve and reaps it on idle.
  readonly runnerPid: number
  readonly port: number
  readonly host: string
  readonly baseURL: string
  // Ephemeral config dir/file the runner cleans up when the serve stops.
  readonly configPath: string
  readonly startedAt: string
  readonly idleTimeoutMs: number
}

function recordPath(fleetKey: string): string {
  return join(managedServesDir(), `${fleetKey}.json`)
}

export function consumersDir(fleetKey: string): string {
  return join(managedServesDir(), `${fleetKey}.consumers`)
}

export function lockPath(fleetKey: string): string {
  return join(managedServesDir(), `${fleetKey}.lock`)
}

// `kill(pid, 0)` is the portable liveness probe: it sends no signal but throws
// ESRCH when the process is gone. EPERM means it exists but we can't signal it
// (still "alive" for our purposes).
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ── Records ─────────────────────────────────────────────────────────────────

export async function writeRecord(record: ServeRecord): Promise<void> {
  await mkdir(managedServesDir(), { recursive: true })
  const final = recordPath(record.fleetKey)
  const tmp = `${final}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  // Rename is atomic on the same filesystem, so a reader never sees a partial
  // record.
  await rename(tmp, final)
}

function parseRecord(raw: string): ServeRecord | undefined {
  try {
    const r = JSON.parse(raw) as ServeRecord
    if (typeof r.servePid === 'number' && typeof r.baseURL === 'string') return r
  } catch {
    // corrupt/partial record — treated as absent
  }
  return undefined
}

export async function readRecord(fleetKey: string): Promise<ServeRecord | undefined> {
  try {
    return parseRecord(await readFile(recordPath(fleetKey), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

export async function readAllRecords(): Promise<ServeRecord[]> {
  let files: string[]
  try {
    files = await readdir(managedServesDir())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const records: ServeRecord[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const rec = parseRecord(await readFile(join(managedServesDir(), file), 'utf8'))
      if (rec !== undefined) records.push(rec)
    } catch {
      // skip unreadable
    }
  }
  return records
}

// Drops a serve record. By default it also clears the consumers dir (the serve
// is gone, so its markers are meaningless). Pass `preserveConsumers` when a new
// runner will respawn this exact fleet key — the live markers must survive the
// crash+respawn so the new runner inherits every still-alive consumer instead of
// reaping the serve out from under idle sessions. Sync so it also works in the
// runner's exit-path cleanup, where async fs can't flush.
export function removeRecord(fleetKey: string, opts?: { preserveConsumers?: boolean }): void {
  try {
    unlinkSync(recordPath(fleetKey))
  } catch {
    // best-effort
  }
  if (opts?.preserveConsumers !== true) {
    try {
      rmSync(consumersDir(fleetKey), { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}

// ── Consumers ────────────────────────────────────────────────────────────────

// `consumerId` identifies a single provider instance, not just its process —
// it must start with the pid (e.g. `"<pid>.<rand>"`) so `liveConsumers` can
// still derive liveness, but be unique per instance so two providers in one
// process sharing a fleet key don't collide on one marker (closing one would
// otherwise deregister the whole process while the other is still live).
export async function addConsumer(fleetKey: string, consumerId: string | number): Promise<void> {
  const dir = consumersDir(fleetKey)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, String(consumerId)), '', 'utf8')
}

// Sync (and best-effort) so it works in `process.on('exit')` handlers too, where
// async can't run; removing a marker is a single `unlinkSync` anyway.
export function removeConsumer(fleetKey: string, consumerId: string | number): void {
  try {
    unlinkSync(join(consumersDir(fleetKey), String(consumerId)))
  } catch {
    // best-effort
  }
}

// Returns the live consumer pids, pruning marker files for dead processes as a
// side effect so the set never wedges on a crashed consumer. Markers are named
// `<pid>` or `<pid>.<rand>`; `parseInt` yields the leading pid either way.
export async function liveConsumers(fleetKey: string): Promise<number[]> {
  const dir = consumersDir(fleetKey)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const alive: number[] = []
  for (const file of files) {
    const pid = Number.parseInt(file, 10)
    if (!Number.isInteger(pid)) {
      await rm(join(dir, file), { force: true }).catch(() => {})
      continue
    }
    if (isProcessAlive(pid)) alive.push(pid)
    else await rm(join(dir, file), { force: true }).catch(() => {})
  }
  return alive
}

// ── Health & discovery ────────────────────────────────────────────────────────

export async function healthCheck(
  baseURL: string,
  fetchImpl: typeof fetch,
  timeoutMs = 2_000
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${baseURL}/models`, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// A serve is reusable iff its record exists, both the serve and its runner are
// alive, and it answers a health check. (Requiring the runner be alive avoids
// attaching to an orphan that the next sweep would kill.)
export async function findReusableServe(
  fleetKey: string,
  fetchImpl: typeof fetch
): Promise<ServeRecord | undefined> {
  const rec = await readRecord(fleetKey)
  if (rec === undefined) return undefined
  if (!isProcessAlive(rec.servePid) || !isProcessAlive(rec.runnerPid)) return undefined
  if (!(await healthCheck(rec.baseURL, fetchImpl))) return undefined
  return rec
}

// Reaps only serves that are dead or orphaned — NEVER a healthy serve whose
// runner is alive (the runner owns idle reaping). Dead serve → drop record.
// Live serve with a dead runner → kill the orphan and drop the record. Returns
// the fleet keys swept.
export async function sweepServes(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const records = await readAllRecords()
  const swept: string[] = []
  for (const rec of records) {
    const serveAlive = isProcessAlive(rec.servePid)
    if (serveAlive && isProcessAlive(rec.runnerPid)) continue // healthy, owned

    if (serveAlive) {
      // Orphan: runner gone, nobody will reap it. Only act if it still answers
      // as *our* serve on the recorded baseURL. If it doesn't respond we must
      // NOT drop the record: the pid is alive, so removing its registry trace
      // would strand a (possibly transiently-unhealthy) live serve that nothing
      // could later find or reap. Leave it for a future sweep — once it answers
      // we reap it, once its pid dies we drop it. (A truly dead serve whose pid
      // the OS recycled to a stranger also lands here; its stale record is
      // harmless — reuse health-checks and skips it, and the next spawn for the
      // key overwrites it.)
      if (!(await healthCheck(rec.baseURL, fetchImpl))) continue
      try {
        process.kill(rec.servePid, 'SIGTERM')
      } catch {
        // already gone or unsignalable
      }
    }
    // Keep live consumer markers: a session re-resolving for this key will
    // respawn the serve, and the new runner must see the other still-alive
    // sessions instead of idle-reaping the fresh serve out from under them.
    removeRecord(rec.fleetKey, { preserveConsumers: true })
    // The orphan's runner also owned the ephemeral config; clean it up.
    if (rec.configPath.length > 0) {
      await rm(dirname(rec.configPath), { recursive: true, force: true }).catch(() => {})
    }
    swept.push(rec.fleetKey)
  }
  return swept
}

export function ensureDirSync(): void {
  mkdirSync(managedServesDir(), { recursive: true })
}

// Atomic-ish sync record write for the runner (avoids a partial record race on
// startup without pulling in async in signal handlers).
export function writeRecordSync(record: ServeRecord): void {
  ensureDirSync()
  const final = recordPath(record.fleetKey)
  const tmp = `${final}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tmp, final)
}
