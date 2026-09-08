// Bare worklet: /proc memory sampler (Android).
//
// react-native-bare-kit runs this file as a Bare thread *inside the app
// process*. Because the QVAC inference worklet also runs in-process on mobile
// (a thread, not a child process like on desktop), the app's own /proc/self
// already accounts for inference memory — so reading it here captures the
// whole picture without any extra permissions (reading your own /proc is
// always allowed, even under Android's SELinux policy; the restrictions only
// apply to *other* processes).
//
// bare-fs is used rather than the React Native file APIs because /proc entries
// are zero-length pseudo-files: stat() reports size 0, so size-based readers
// return an empty string. bare-fs reads them with a streaming read loop and
// gets the real contents.
//
// Each tick we read:
//   - /proc/self/maps          -> number of mapped regions   (metric maps.count)
//   - /proc/self/status        -> VmRSS in kB                 (metric status.VmRSS),
//                                 the resident secondary. Virtual totals
//                                 (VmSize/VmPeak) are intentionally not sampled:
//                                 they count reserved-but-uncommitted address
//                                 space and are useless as a usage signal.
//   - /proc/self/smaps_rollup  -> Private_Clean + Private_Dirty -> USS in kB
//                                 (metric smaps_rollup.uss). USS is the memory
//                                 unique to this process -- what would be freed
//                                 if it died -- which is the best signal for
//                                 leak hunting. Absent on older kernels
//                                 (smaps_rollup landed in Linux 4.14), in which
//                                 case the series is simply skipped.
// and once at startup:
//   - /proc/sys/vm/max_map_count -> the kernel ceiling the mmap-region count
//                                   is measured against (the relevant OOM-ish
//                                   limit for mmap-heavy workloads).
//
// Samples are batched per tick and pushed to the React Native side over
// bare-rpc, which publishes them on qvac/app-memory with their metric labels.

/* global BareKit, Bare */
import RPC from 'bare-rpc'
import fs from 'bare-fs'

// Must match RPC_MEM_SAMPLE in consumer-wrapper.tsx.
const RPC_MEM_SAMPLE = 1

const DEFAULT_INTERVAL_MS = 500

// Bare.argv carries the args passed to worklet.start(); the sample interval in
// ms is the last argv entry. Fall back to the default for any non-positive /
// unparseable value.
function readIntervalMs() {
  try {
    const raw = Array.isArray(Bare?.argv) ? Bare.argv[Bare.argv.length - 1] : undefined
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS
  } catch {
    return DEFAULT_INTERVAL_MS
  }
}

function readFileSafe(path) {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readIntFile(path) {
  const raw = readFileSafe(path)
  if (raw === null) return null
  const n = parseInt(raw.trim(), 10)
  return Number.isFinite(n) ? n : null
}

// Count mapped regions = number of non-empty lines in /proc/self/maps.
function readMapsCount() {
  const raw = readFileSafe('/proc/self/maps')
  if (raw === null) return null
  let count = 0
  let lineHasContent = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c === 10 /* \n */) {
      if (lineHasContent) count++
      lineHasContent = false
    } else if (c !== 13 /* \r */) {
      lineHasContent = true
    }
  }
  if (lineHasContent) count++
  return count
}

// Pull a single `Key:   <number> kB` field out of a /proc text blob
// (/proc/self/status or /proc/self/smaps_rollup share the `Key: N kB` format).
function parseProcKb(text, key) {
  const re = new RegExp('^' + key + ':\\s*(\\d+)\\s*kB', 'm')
  const m = text.match(re)
  return m ? parseInt(m[1], 10) : null
}

// USS (unique set size) = memory private to this process, i.e. what would be
// reclaimed if it exited. Derived from /proc/self/smaps_rollup as
// Private_Clean + Private_Dirty. Returns null when smaps_rollup is unavailable
// or neither field is present.
function readUssKb() {
  const rollup = readFileSafe('/proc/self/smaps_rollup')
  if (rollup === null) return null
  const clean = parseProcKb(rollup, 'Private_Clean')
  const dirty = parseProcKb(rollup, 'Private_Dirty')
  if (clean === null && dirty === null) return null
  return (clean ?? 0) + (dirty ?? 0)
}

const intervalMs = readIntervalMs()
const rpc = new RPC(BareKit.IPC)

// One-time ceiling for the mmap-region count. Null on devices that don't
// expose it (older / locked-down kernels) — the count series still works,
// just without a limit line.
const maxMapCount = readIntFile('/proc/sys/vm/max_map_count')

// If /proc isn't readable at all (e.g. running on a non-Linux platform by
// mistake), don't spin a timer that produces nothing.
if (readFileSafe('/proc/self/status') === null && readMapsCount() === null) {
  console.log('[proc-mem] /proc not readable; sampler idle')
} else {
  const send = () => {
    const ts = Date.now()
    const samples = []

    const mapsCount = readMapsCount()
    if (mapsCount !== null) {
      samples.push({
        ts,
        metric: 'maps.count',
        unit: 'count',
        value: mapsCount,
        limit: maxMapCount,
      })
    }

    const status = readFileSafe('/proc/self/status')
    if (status !== null) {
      const vmRss = parseProcKb(status, 'VmRSS')
      if (vmRss !== null) samples.push({ ts, metric: 'status.VmRSS', unit: 'kb', value: vmRss, limit: null })
    }

    const ussKb = readUssKb()
    if (ussKb !== null) {
      samples.push({ ts, metric: 'smaps_rollup.uss', unit: 'kb', value: ussKb, limit: null })
    }

    if (samples.length === 0) return
    try {
      const req = rpc.request(RPC_MEM_SAMPLE)
      req.send(JSON.stringify(samples))
    } catch {
      // best-effort; never throw out of the timer
    }
  }

  send()
  const timer = setInterval(send, intervalMs)
  // Don't let the sampler keep the worklet alive on its own.
  if (typeof timer?.unref === 'function') timer.unref()
  console.log('[proc-mem] sampler started (interval ' + intervalMs + 'ms, max_map_count ' + maxMapCount + ')')
}
