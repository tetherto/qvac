import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Aggregates in-app memory samples + producer-side test timeline into one
 * `MemorySummary` per metric, consumed by the report generator.
 *
 * Samples are published from the consumer over MQTT (`qvac/app-memory`) and
 * appended to `app-mem.ndjson` by the orchestrator. The sample stream is
 * crash-resilient: messages reach the producer immediately, so a hard crash
 * on the device does not lose the run-up to the crash.
 *
 * A single run can carry several independent series, each tagged with its own
 * `metric` label (e.g. `smaps_rollup.pss`, `smaps_rollup.uss`,
 * `maps.count`).
 * Samples are grouped by metric and each group is summarized separately so the
 * report can draw a chart + per-test delta table per series.
 *
 * Inputs (both NDJSON, both written by the orchestrator):
 *   - app-mem.ndjson        -- one record per in-app memory sample
 *   - test-timeline.ndjson  -- start/end events emitted by the orchestrator
 *
 * Outputs in each `MemorySummary`:
 *   - peakSuite     -- `max(memoryKb)` across the run, plus active testId at peak
 *   - perTest       -- per-test peak / mean / growth from samples in window
 *   - chart         -- raw samples + rolling max5s / max60s for plotting
 *   - metric        -- in-app metric label
 *   - unit          -- how to interpret the values ("kb" for memory sizes,
 *                      "count" for dimensionless counters like mmap regions)
 *   - platform
 */
/**
 * How to interpret a series' numeric values. `kb` is a memory size in
 * kibibytes (rendered as KB/MB/GB); `count` is a raw integer counter such as
 * the number of mmap regions (rendered as a plain number). The `memoryKb`
 * field on a sample is the generic value carrier regardless of unit.
 */
export type MemoryUnit = 'kb' | 'count'

export interface MemorySample {
  ts: number
  pid: number | null
  /** Generic value carrier. KB for `unit: 'kb'`, a raw count for `unit: 'count'`. */
  memoryKb: number
  peakKb: number | null
  /** Ceiling for the series in the same unit as `memoryKb` (e.g. max_map_count). */
  limitKb: number | null
  metric: string
  unit: MemoryUnit
  platform: 'android' | 'ios' | 'desktop'
}

export interface TimelineEvent {
  ts: number
  consumerId: string
  testId: string
  uniqueTestId: string
  phase: 'start' | 'end' | 'reload'
}

export interface PerTestMemory {
  testId: string
  uniqueTestId: string
  consumerId: string
  startTs: number
  /**
   * For completed tests, when the consumer reported the result. For
   * incomplete tests (consumer crashed before sending result), the last
   * memory sample timestamp -- so the test still appears in the table
   * with whatever memory data we captured up to the crash.
   */
  endTs: number
  durationMs: number
  /** First sample observed after the test was assigned. */
  beforeKb: number | null
  peakKb: number
  meanKb: number
  /** Last sample observed before test end (or before crash for incomplete). */
  afterKb: number | null
  /** afterKb - beforeKb when both are present; null otherwise. */
  deltaKb: number | null
  samples: number
  /**
   * True when the consumer never reported a result for this test --
   * typically because it crashed mid-test (e.g. OOM kill). The endTs is
   * synthesized from the last memory sample.
   */
  incomplete: boolean
  /** Present only for retry-split windows. */
  attemptLabel?: '1' | '2'
}

export interface RollingPoint {
  ts: number
  memoryKb: number
  max5sKb: number
  max60sKb: number
}

export interface MemorySummary {
  metric: string
  unit: MemoryUnit
  platform: 'android' | 'ios' | 'desktop'
  limitKb: number | null
  startTs: number
  endTs: number
  durationMs: number
  peakSuite: {
    memoryKb: number
    ts: number
    activeTestId: string | null
  }
  growthKb: number
  perTest: PerTestMemory[]
  chart: RollingPoint[]
}

const ROLL_5S_MS = 5_000
const ROLL_60S_MS = 60_000

export function readMemorySamples(filePath: string): MemorySample[] {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf8')
  const out: MemorySample[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as Partial<MemorySample>
      if (typeof obj.ts !== 'number' || typeof obj.memoryKb !== 'number') continue
      if (!obj.platform) continue
      out.push({
        ts: obj.ts,
        pid: obj.pid ?? null,
        memoryKb: obj.memoryKb,
        peakKb: obj.peakKb ?? null,
        limitKb: obj.limitKb ?? null,
        metric: obj.metric ?? 'unknown',
        unit: obj.unit === 'count' ? 'count' : 'kb',
        platform: obj.platform
      })
    } catch {
      // skip malformed lines (e.g. truncated final line on crash)
    }
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

export function readTimeline(filePath: string): TimelineEvent[] {
  if (!fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf8')
  const out: TimelineEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as TimelineEvent
      if (
        typeof obj.ts === 'number' &&
        (obj.phase === 'start' || obj.phase === 'end' || obj.phase === 'reload')
      ) {
        out.push(obj)
      }
    } catch {
      // skip
    }
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

/**
 * Compute a sliding-window maximum over a sorted-by-ts series.
 *
 * O(n) using a monotonic deque; window is the time interval ending at each
 * sample's timestamp.
 */
function rollingMax(samples: MemorySample[], windowMs: number): number[] {
  const result: number[] = new Array(samples.length)
  // deque holds indices into samples, memoryKb descending
  const deque: number[] = []
  for (let i = 0; i < samples.length; i++) {
    const tCur = samples[i].ts
    // pop expired
    while (deque.length > 0 && samples[deque[0]].ts < tCur - windowMs) deque.shift()
    // pop smaller-or-equal from the back
    while (deque.length > 0 && samples[deque[deque.length - 1]].memoryKb <= samples[i].memoryKb) {
      deque.pop()
    }
    deque.push(i)
    result[i] = samples[deque[0]].memoryKb
  }
  return result
}

function findActiveTest(timeline: TimelineEvent[], ts: number): string | null {
  // Linear is fine: timeline is small (~2*tests).
  let active: string | null = null
  for (const ev of timeline) {
    if (ev.ts > ts) break
    if (ev.phase === 'start') active = ev.testId
    else if (ev.phase === 'end' && active === ev.testId) active = null
  }
  return active
}

function buildPerTestEntry(
  samples: MemorySample[],
  start: TimelineEvent,
  startTs: number,
  endTs: number,
  incomplete: boolean,
  attemptLabel?: '1' | '2'
): PerTestMemory {
  const inWindow = samples.filter((s) => s.ts >= startTs && s.ts <= endTs)

  let peakKb = 0
  let meanKb = 0
  if (inWindow.length > 0) {
    peakKb = inWindow[0].memoryKb
    let sum = 0
    for (const s of inWindow) {
      if (s.memoryKb > peakKb) peakKb = s.memoryKb
      sum += s.memoryKb
    }
    meanKb = Math.round(sum / inWindow.length)
  }

  // Use only in-window samples here; gap samples between tests can already
  // include the next test's setup work and would contaminate before/after.
  const beforeKb = inWindow.length > 0 ? inWindow[0].memoryKb : null
  const afterKb = inWindow.length > 0 ? inWindow[inWindow.length - 1].memoryKb : null
  const deltaKb = beforeKb !== null && afterKb !== null ? afterKb - beforeKb : null

  return {
    testId: start.testId,
    uniqueTestId: start.uniqueTestId,
    consumerId: start.consumerId,
    startTs,
    endTs,
    durationMs: endTs - startTs,
    beforeKb,
    peakKb,
    meanKb,
    afterKb,
    deltaKb,
    samples: inWindow.length,
    incomplete,
    ...(attemptLabel !== undefined && { attemptLabel })
  }
}

function aggregatePerTest(samples: MemorySample[], timeline: TimelineEvent[]): PerTestMemory[] {
  const starts = new Map<string, TimelineEvent>()
  const reloads = new Map<string, TimelineEvent>()
  const windows: { start: TimelineEvent; end: TimelineEvent | null }[] = []
  for (const ev of timeline) {
    if (ev.phase === 'start') {
      starts.set(ev.uniqueTestId, ev)
      continue
    }
    if (ev.phase === 'reload') {
      reloads.set(ev.uniqueTestId, ev)
      continue
    }
    // phase === 'end'
    const start = starts.get(ev.uniqueTestId)
    if (!start) continue
    starts.delete(ev.uniqueTestId)
    windows.push({ start, end: ev })
  }
  // Keep orphan starts so crashed tests still appear in the table.
  for (const start of starts.values()) {
    windows.push({ start, end: null })
  }
  windows.sort((a, b) => a.start.ts - b.start.ts)

  const lastSampleTs = samples.length > 0 ? samples[samples.length - 1].ts : 0
  const out: PerTestMemory[] = []

  for (const w of windows) {
    const start = w.start
    const incomplete = w.end === null
    // For incomplete tests, use the last sample timestamp as the synthetic end.
    const endTs = w.end ? w.end.ts : lastSampleTs

    const reloadEv = reloads.get(start.uniqueTestId)
    if (reloadEv) {
      const splitTs = Math.max(start.ts, Math.min(reloadEv.ts, endTs))
      if (splitTs > start.ts && splitTs < endTs) {
        out.push(buildPerTestEntry(samples, start, start.ts, splitTs - 1, false, '1'))
        out.push(buildPerTestEntry(samples, start, splitTs, endTs, incomplete, '2'))
      } else {
        out.push(buildPerTestEntry(samples, start, start.ts, endTs, incomplete))
      }
    } else {
      out.push(buildPerTestEntry(samples, start, start.ts, endTs, incomplete))
    }
  }

  return out
}

/**
 * Summarize a single metric's samples (already filtered to one `metric`) into
 * a `MemorySummary`. `samples` must be sorted by `ts` and non-empty.
 */
function summarizeSeries(samples: MemorySample[], timeline: TimelineEvent[]): MemorySummary {
  const first = samples[0]
  const last = samples[samples.length - 1]

  // Suite peak
  let peakSampleIdx = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].memoryKb > samples[peakSampleIdx].memoryKb) peakSampleIdx = i
  }
  const peakSample = samples[peakSampleIdx]

  // Rolling windows
  const max5s = rollingMax(samples, ROLL_5S_MS)
  const max60s = rollingMax(samples, ROLL_60S_MS)
  const chart: RollingPoint[] = samples.map((s, i) => ({
    ts: s.ts,
    memoryKb: s.memoryKb,
    max5sKb: max5s[i],
    max60sKb: max60s[i]
  }))

  // Per-test
  const perTest = aggregatePerTest(samples, timeline).sort((a, b) => b.peakKb - a.peakKb)

  // Limit (latest non-null)
  let limitKb: number | null = null
  for (const s of samples) {
    if (s.limitKb !== null) limitKb = s.limitKb
  }

  return {
    metric: first.metric,
    unit: first.unit,
    platform: first.platform,
    limitKb,
    startTs: first.ts,
    endTs: last.ts,
    durationMs: last.ts - first.ts,
    peakSuite: {
      memoryKb: peakSample.memoryKb,
      ts: peakSample.ts,
      activeTestId: findActiveTest(timeline, peakSample.ts)
    },
    growthKb: last.memoryKb - first.memoryKb,
    perTest,
    chart
  }
}

// Preferred display order for known metrics; everything else is appended
// alphabetically. Ordering reflects how useful each series is for memory
// profiling:
//   1. Primary OOM-relevant series first (PSS on Android, phys_footprint on
//      iOS) so the Memory tab opens on the chart that drives jetsam/LMK.
//   2. Resident + unique (RSS / USS) as secondary "real usage" signals.
//   3. Address-space diagnostics (VM region / mmap counts) for mmap-leak
//      hunting.
// Virtual-size totals (virtual_size / VmSize / VmPeak) are deliberately not
// collected: they count reserved-but-uncommitted address space, so they're
// huge, noisy, and useless as a memory-consumption signal. Region/mmap counts
// cover address-space leak detection better.
const METRIC_ORDER = [
  'smaps_rollup.pss',
  'task_vm_info.physFootprint',
  'physFootprint',
  'smaps_rollup.uss',
  'task_vm_info.resident_size',
  'rss',
  'VmRSS',
  'status.VmRSS',
  'task_vm_info.region_count',
  'maps.count'
]

function metricRank(metric: string): number {
  const idx = METRIC_ORDER.indexOf(metric)
  return idx === -1 ? METRIC_ORDER.length : idx
}

/**
 * Read `app-mem.ndjson`, group samples by `metric`, and summarize each group
 * independently. Returns one `MemorySummary` per metric, ordered with the
 * primary resident-memory series first. Empty array when no samples exist.
 */
export function aggregateMemory(reportDir: string): MemorySummary[] {
  const samples = readMemorySamples(path.join(reportDir, 'app-mem.ndjson'))
  if (samples.length === 0) return []

  const timeline = readTimeline(path.join(reportDir, 'test-timeline.ndjson'))

  // Group by metric, preserving the per-metric ts ordering inherited from the
  // already-sorted `samples` array.
  const byMetric = new Map<string, MemorySample[]>()
  for (const s of samples) {
    const list = byMetric.get(s.metric)
    if (list) list.push(s)
    else byMetric.set(s.metric, [s])
  }

  const summaries: MemorySummary[] = []
  for (const group of byMetric.values()) {
    summaries.push(summarizeSeries(group, timeline))
  }

  summaries.sort((a, b) => {
    const rank = metricRank(a.metric) - metricRank(b.metric)
    return rank !== 0 ? rank : a.metric.localeCompare(b.metric)
  })

  return summaries
}
