import type { Capabilities, WatchStream } from '@qvac/core/client'
type DownloadFrame =
  ReturnType<Capabilities['modelDownloadsWatch']> extends WatchStream<infer T>
    ? T extends { downloads?: ReadonlyArray<infer D> | null }
      ? D
      : never
    : never
import type { CommandIO } from './io.js'
import type { RuntimeOptions } from '../lib/types.js'
import { bytes, duration } from './format.js'

// Weight of the newest sample; enough smoothing that one slow frame does not swing the ETA.
const SMOOTHING = 0.3

// Speed is measured from the frames themselves, so it is right however often they arrive.
export function downloadMeter() {
  let previous: { downloaded: number; updatedAt: number } | null = null
  let speed = 0

  return (frame: DownloadFrame) => {
    const { downloaded = 0, total = 0, updatedAt } = frame
    if (previous && updatedAt > previous.updatedAt && downloaded >= previous.downloaded) {
      const sample = ((downloaded - previous.downloaded) * 1000) / (updatedAt - previous.updatedAt)
      speed = speed ? speed + SMOOTHING * (sample - speed) : sample
    }

    previous = { downloaded, updatedAt }
    const percent = total ? Math.floor((downloaded / total) * 100) : (frame.percentage ?? 0)
    const eta = speed && total ? (total - downloaded) / speed : null

    return { name: frame.name, phase: frame.phase, percent, downloaded, total, speed, eta }
  }
}

export function progressLine({
  name,
  phase,
  percent,
  downloaded,
  total,
  speed,
  eta
}: ReturnType<ReturnType<typeof downloadMeter>>) {
  if (phase !== 'downloading') return `${name}  ${phase}`
  const parts = [`${name}  ${String(percent).padStart(3)}%`]
  if (total) {
    parts.push(`${bytes(downloaded)} of ${bytes(total)}`)
  }

  if (speed) {
    parts.push(`${bytes(speed)}/s`)
  }

  if (eta !== null) {
    parts.push(`${duration(eta)} left`)
  }

  return parts.join('  ·  ')
}

// A TTY gets one line redrawn in place; JSON a line per percent; a log a line per tenth.
export function progressReporter(options: RuntimeOptions, io: CommandIO) {
  let last: string | null = null
  const report = (progress: ReturnType<ReturnType<typeof downloadMeter>>) => {
    if (io.tty.stdout && !options.json) {
      return io.redraw(progressLine(progress))
    }

    const step = options.json ? progress.percent : Math.floor(progress.percent / 10)
    const key = `${progress.name} ${progress.phase} ${step}`
    if (key === last) {
      return
    }

    last = key
    if (options.json) {
      io.json({ event: 'download', ...progress })
    } else {
      io.line(progressLine(progress))
    }
  }
  report.end = () => io.redraw(null)

  return report
}
