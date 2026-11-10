const WINDOW_MS = 10000

// Estimates transfer speed from successive download snapshots, per model name.
export class DownloadRate {
  windowMs: number
  samples: Map<string, { downloaded: number; at: number }[]>
  constructor({ windowMs = WINDOW_MS } = {}) {
    this.windowMs = windowMs
    this.samples = new Map()
  }

  sample(name: string, downloaded: number, now = Date.now()) {
    const list = this.samples.get(name) || []
    const last = list.at(-1)!
    if (last?.downloaded === downloaded) {
      return
    }

    // A restarted download starts a fresh history.
    if (last && last.downloaded > downloaded) {
      list.length = 0
    }

    list.push({ downloaded, at: now })
    while (list.length > 2 && now - list[0]!.at > this.windowMs) {
      list.shift()
    }

    this.samples.set(name, list)
  }

  // Bytes per second over the sampled window, or 0 until two samples exist.
  speed(name: string) {
    const list = this.samples.get(name) || []
    if (list.length < 2) {
      return 0
    }

    const first = list[0]!,
      last = list.at(-1)!

    return ((last.downloaded - first.downloaded) * 1000) / Math.max(1, last.at - first.at)
  }

  remaining(name: string, { downloaded, total }: { downloaded: number; total: number }) {
    const speed = this.speed(name)
    return speed > 0 && total > downloaded ? (total - downloaded) / speed : null
  }
}

export function remainingText(seconds: number | null) {
  if (seconds === null) return 'estimating time'
  if (seconds < 10) return 'a few seconds remaining'
  if (seconds < 90) {
    return `${Math.round(seconds)}s remaining`
  }

  return `${Math.round(seconds / 60)} min remaining`
}
