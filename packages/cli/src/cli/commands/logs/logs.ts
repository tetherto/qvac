import type { ParsedCommand, LauncherKit } from '../../../lib/types.js'
interface Output {
  write(data: string | Uint8Array): unknown
}
import fs from '#fs'
import b4a from 'b4a'
import path from '#path'

const BLOCK = 64 * 1024

export function logFiles(dataDir: string, env: Record<string, string | undefined> = {}) {
  const files = [
    env['QVAC_LOG_FILE'] || path.join(dataDir, 'assistant.log'),
    path.join(dataDir, 'harness.log')
  ]
  return files.filter((file) => fs.existsSync(file))
}

export function tailLines(file: string, count: number) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    let start = size
    let tail = b4a.alloc(0)
    while (start > 0 && newlines(tail) <= count) {
      const length = Math.min(BLOCK, start)
      start -= length
      const chunk = b4a.alloc(length)
      fs.readSync(fd, chunk, 0, length, start)
      tail = b4a.concat([chunk, tail])
    }

    const lines = b4a.toString(tail, 'utf8').split('\n')
    if (lines.at(-1) === '') {
      lines.pop()
    }

    return { lines: count ? lines.slice(-count) : [], size }
  } finally {
    fs.closeSync(fd)
  }
}

function newlines(buf: Buffer<ArrayBufferLike> | Uint8Array<ArrayBufferLike>) {
  let n = 0
  for (let at = b4a.indexOf(buf, 10); at !== -1; at = b4a.indexOf(buf, 10, at + 1)) {
    n++
  }

  return n
}

export function printLogs(files: string[], { tail = 50, out }: { tail?: number; out: Output }) {
  const offsets = new Map<string, number>()
  for (const file of files) {
    const { lines, size } = tailLines(file, tail)
    if (files.length > 1) {
      out.write(`==> ${file} <==\n`)
    }

    out.write(lines.map((line) => line + '\n').join(''))
    offsets.set(file, size)
  }

  return offsets
}

// Resolves when the signal aborts; every append to a file is printed as it lands.
export function followLogs(
  offsets: Map<string, number>,
  { out, signal }: { out: Output; signal: AbortSignal }
) {
  const printed: { last: string | null } = { last: null }
  const drain = (file: string) => {
    const appended = readFrom(file, offsets.get(file)!)
    if (!appended) {
      return
    }

    offsets.set(file, appended.size)
    if (offsets.size > 1 && printed.last !== file) {
      out.write(`\n==> ${file} <==\n`)
    }

    printed.last = file
    out.write(appended.chunk)
  }
  const watchers = [...offsets.keys()].map((file) => fs.watch(file, () => drain(file)))
  // what landed between the tail and the watch starting is printed now, not on the next write
  for (const file of offsets.keys()) {
    drain(file)
  }

  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => {
      for (const watcher of watchers) {
        watcher.close()
      }

      resolve()
    })
  })
}

// A file that shrank was rotated or truncated, so it is read again from the start.
function readFrom(file: string, offset: number) {
  const size = fs.statSync(file).size
  const from = size < offset ? 0 : offset
  if (size === from) {
    return null
  }

  const chunk = b4a.alloc(size - from)
  const fd = fs.openSync(file, 'r')
  fs.readSync(fd, chunk, 0, chunk.length, from)
  fs.closeSync(fd)

  return { chunk, size }
}

// qvac logs [-f] [--tail N]: the end of each log, then what is appended while it follows
export async function runLogs(
  { options }: ParsedCommand,
  { usage, loadConfig, dataDir, AbortController, process }: LauncherKit
) {
  if (options.temp) {
    usage('logs reads a device that has run; a --temp store has none yet.')
  }

  const { core } = (await loadConfig(options.configFile)).config
  const dir = dataDir(options, core)
  const files = logFiles(dir, process.env)
  if (!files.length) {
    console.error(`qvac: no logs yet in ${dir}. They start with qvac serve or qvac.`)
    process.exit(1)
  }

  const offsets = printLogs(files, { tail: Number(options.tail ?? 50), out: process.stdout })
  if (!options.follow) {
    return
  }

  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort())
  process.once('SIGTERM', () => stop.abort())
  await followLogs(offsets, { out: process.stdout, signal: stop.signal })
}
