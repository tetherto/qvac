'use strict'
// MEASUREMENT METHODOLOGY — how rounds are scheduled so deltas are trustworthy
// (config.cjs `methodology` block is the knobs).
//
// Target behaviour (per docs/perf/metal-baseline.md findings):
//   • 1 warmup block + N measured blocks per source; the report takes the
//     MEDIAN per metric (a "block" = one full pass over the fixture for one
//     source × model × backend; marker field `block`: 0 = warmup, 1.. = measured)
//   • blocks INTERLEAVED across sources (B,C,B,C…) so neither build
//     systematically runs on a hotter machine (per-inference interleaving is
//     impossible — two addon builds can't share one process)
//   • STABILITY GUARD between blocks: real temperature sensor where available
//     (self-hosted Mac mini, pending sudo/powermetrics confirmation), else a
//     fixed micro-workload whose timing must stabilise (sensor-free proxy)
//
// The desktop scheduler (run-desktop.cjs) drives interleaved blocks across
// processes with these helpers. The harness calls stabilityGuard() directly for
// its own single-process warmup (mobile + desktop-direct). The report takes the
// median per metric over measured blocks (block >= 1) and drops warmup (block 0).

// Block plan for one (model × backend): the order sources run their blocks in.
// interleave=true → [s1.warmup, s2.warmup, s1.b1, s2.b1, s1.b2, s2.b2, …]
function planBlocks (sourceIds, m) {
  const warmup = m && m.warmupBlocks != null ? m.warmupBlocks : 1
  const measured = m && m.measuredBlocks != null ? m.measuredBlocks : 3
  const interleave = !m || m.interleave !== false
  const plan = []
  const rounds = []
  for (let b = -warmup + 1; b <= measured; b++) rounds.push(Math.max(0, b)) // 0,1..N (0 repeated warmup times)
  if (interleave) {
    for (const block of rounds) for (const id of sourceIds) plan.push({ source: id, block })
  } else {
    for (const id of sourceIds) for (const block of rounds) plan.push({ source: id, block })
  }
  return plan
}

// Median — the reported statistic (robust against one-off hiccups).
function median (xs) {
  const a = xs.filter(v => v != null).slice().sort((x, y) => x - y)
  if (!a.length) return null
  const mid = a.length >> 1
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

// ── stability guard ────────────────────────────────────────────────────────
// Between blocks we wait for the machine to return to a steady thermal state, so
// a hot run doesn't masquerade as a slow build.
// Strategies:
//   • 'temp'  — read a real sensor (Mac mini via powermetrics). Not wired yet
//               (needs sudo); falls back to 'probe' so the guard is always live.
//   • 'probe' — sensor-free: run a fixed CPU micro-workload and wait until its
//               timing flattens (a window of probes within tolerance). Works
//               everywhere, no privileges. Default.
//   • 'off'   — no wait (CI A/A debugging only).
// Mobile calls this once after its in-harness warmup, bounded tight (maxWaitMs)
// to stay under the Device Farm per-test ceiling.

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// A fixed CPU micro-workload; returns elapsed ms. probeIters is calibrated once
// to ~targetMs so timer granularity doesn't swamp the signal.
let probeIters = 4e6
let probeCalibrated = false
function probeOnce () {
  const t0 = Date.now()
  let x = 0
  for (let i = 0; i < probeIters; i++) x += Math.sqrt((i % 9973) + 1.5)
  return { ms: Date.now() - t0, sink: x }
}
function calibrateProbe (targetMs) {
  const { ms } = probeOnce()
  if (ms > 0) probeIters = Math.max(1e5, Math.round(probeIters * (targetMs / ms)))
  probeCalibrated = true
}

const STABILITY_DEFAULTS = { mode: 'probe', maxWaitMs: 45000, intervalMs: 1200, window: 4, tolerancePct: 5, targetMs: 40 }

// Resolves { kind, value_ms, waited_ms } for the [VLMBLOCK] marker as soon as the
// probe timing is stable, or when maxWaitMs is hit (best effort).
async function stabilityGuard (opts) {
  const o = Object.assign({}, STABILITY_DEFAULTS, opts || {})
  if (o.mode === 'off') return { kind: 'off', value_ms: null, waited_ms: 0 }
  // 'temp' not wired yet → behave like 'probe' so the guard is never skipped.
  if (!probeCalibrated) calibrateProbe(o.targetMs)
  const start = Date.now()
  const recent = []
  let last = null
  // Hard cap driven by the event loop, NOT an in-loop `Date.now() - start` check:
  // under `bare` on a contended runner that delta can fail to trip, which would leave
  // the guard running unbounded. A setTimeout fires regardless of how Date.now() behaves
  // inside the loop; the loop yields via sleep() each iteration, so the flag is observed
  // within one interval (overshoot <= one probe + interval).
  let capped = false
  const timer = setTimeout(() => { capped = true }, o.maxWaitMs)
  try {
    for (;;) {
      last = probeOnce().ms
      recent.push(last)
      if (recent.length > o.window) recent.shift()
      if (recent.length >= o.window) {
        const mid = median(recent)
        const spread = Math.max(...recent) - Math.min(...recent)
        if (mid > 0 && (spread / mid) * 100 <= o.tolerancePct) {
          return { kind: 'probe', value_ms: Math.round(mid), waited_ms: Date.now() - start }
        }
      }
      if (capped) return { kind: 'probe', value_ms: last != null ? Math.round(last) : null, waited_ms: Date.now() - start }
      await sleep(o.intervalMs)
    }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { planBlocks, median, stabilityGuard }
