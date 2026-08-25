import { chmodSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEFAULT_SERVE_START_TIMEOUT_MS } from '../defaults.js'

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
  readonly apiKey: string
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

type SweepServeRecord = Omit<ServeRecord, 'apiKey'> & { readonly apiKey?: string }

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

export async function ensureManagedServesDir(): Promise<void> {
  await mkdir(managedServesDir(), { recursive: true, mode: 0o700 })
  await chmod(managedServesDir(), 0o700)
}

export async function writeRecord(record: ServeRecord): Promise<void> {
  await ensureManagedServesDir()
  const final = recordPath(record.fleetKey)
  const tmp = `${final}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  // Rename is atomic on the same filesystem, so a reader never sees a partial
  // record.
  await rename(tmp, final)
}

function parseRecordBase(raw: string): SweepServeRecord | undefined {
  try {
    const r = JSON.parse(raw) as SweepServeRecord
    if (
      typeof r.fleetKey === 'string' &&
      typeof r.servePid === 'number' &&
      typeof r.runnerPid === 'number' &&
      typeof r.port === 'number' &&
      typeof r.host === 'string' &&
      typeof r.baseURL === 'string' &&
      typeof r.configPath === 'string' &&
      typeof r.startedAt === 'string' &&
      typeof r.idleTimeoutMs === 'number' &&
      recordDestinationMatches(r)
    ) {
      return r
    }
  } catch {
    // corrupt/partial record — treated as absent
  }
  return undefined
}

function parseRecord(raw: string): ServeRecord | undefined {
  const record = parseRecordBase(raw)
  if (record === undefined || typeof record.apiKey !== 'string' || record.apiKey.length === 0) {
    return undefined
  }
  return record as ServeRecord
}

function recordDestinationMatches(record: Pick<ServeRecord, 'baseURL' | 'host' | 'port'>): boolean {
  try {
    const url = new URL(record.baseURL)
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const host = record.host.replace(/^\[|\]$/g, '').toLowerCase()
    const port =
      url.port.length > 0
        ? Number(url.port)
        : url.protocol === 'https:'
          ? 443
          : url.protocol === 'http:'
            ? 80
            : NaN
    return hostname === host && port === record.port
  } catch {
    return false
  }
}

export async function readRecord(fleetKey: string): Promise<ServeRecord | undefined> {
  try {
    return parseRecord(await readFile(recordPath(fleetKey), 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

export function readAllRecords(): Promise<ServeRecord[]> {
  return readRecords(parseRecord)
}

function readSweepRecords(): Promise<SweepServeRecord[]> {
  return readRecords(parseRecordBase)
}

async function readRecords<T>(parse: (raw: string) => T | undefined): Promise<T[]> {
  let files: string[]
  try {
    files = await readdir(managedServesDir())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const records: T[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const rec = parse(await readFile(join(managedServesDir(), file), 'utf8'))
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
  await ensureManagedServesDir()
  const dir = consumersDir(fleetKey)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const marker = join(dir, String(consumerId))
  await writeFile(marker, '', { encoding: 'utf8', mode: 0o600 })
  await chmod(marker, 0o600)
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

// `apiKey === undefined` probes anonymously, for records written by a provider
// that predates managed auth. Only ever used on a record whose baseURL has
// already been checked against its own host/port.
export async function healthCheck(
  baseURL: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs = 2_000
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${baseURL}/models`, {
      ...(apiKey === undefined ? {} : { headers: { authorization: `Bearer ${apiKey}` } }),
      signal: controller.signal
    })
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
  if (!(await healthCheck(rec.baseURL, rec.apiKey, fetchImpl))) return undefined
  return rec
}

// Reaps only serves that are dead or orphaned — NEVER a healthy serve whose
// runner is alive (the runner owns idle reaping). Dead serve → drop record.
// Live serve with a dead runner → kill the orphan and drop the record. Returns
// the fleet keys swept.
export async function sweepServes(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const records = await readSweepRecords()
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
      //
      // A record with no `apiKey` was written by a provider that predates managed
      // auth, so its serve is listening unauthenticated: probe it anonymously —
      // never with another record's credential — and reap it on the same terms.
      // `parseRecordBase` has already confirmed baseURL agrees with host/port, so
      // the probe cannot be redirected by a tampered record.
      if (!(await healthCheck(rec.baseURL, rec.apiKey, fetchImpl))) continue
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
  await sweepRunnerParams()
  return swept
}

// One-shot runner handoff files carry the serve key in plaintext (mode 0o600) and
// are unlinked by the runner as it reads them. A client that dies in the window
// between write and read leaves one behind with nothing to remove it, so they are
// swept here once no runner could still be waiting to read one: the spawn budget
// plus a wide margin for a machine that was busy or asleep mid-handoff.
export const RUNNER_PARAMS_STALE_MS = DEFAULT_SERVE_START_TIMEOUT_MS * 2

async function sweepRunnerParams(now = Date.now()): Promise<void> {
  let files: string[]
  try {
    files = await readdir(managedServesDir())
  } catch {
    return
  }
  for (const file of files) {
    if (!file.endsWith('.runner-params.json')) continue
    const path = join(managedServesDir(), file)
    try {
      const { mtimeMs } = await stat(path)
      if (now - mtimeMs < RUNNER_PARAMS_STALE_MS) continue
      await rm(path, { force: true })
    } catch {
      // best-effort: a file the runner just consumed is already gone
    }
  }
}

export function ensureDirSync(): void {
  mkdirSync(managedServesDir(), { recursive: true, mode: 0o700 })
  chmodSync(managedServesDir(), 0o700)
}

// Atomic-ish sync record write for the runner (avoids a partial record race on
// startup without pulling in async in signal handlers).
export function writeRecordSync(record: ServeRecord): void {
  ensureDirSync()
  const final = recordPath(record.fleetKey)
  const tmp = `${final}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  renameSync(tmp, final)
}
