import { attach } from 'bare-stow/protocol'
import { pathToFileURL } from 'bare-url'
import type { Duplex } from 'bare-stream'

type Stop = () => Promise<void>
type Start = (ipc: Duplex, ready: () => void) => Stop | void | Promise<Stop | void>

const ipc = attach(Bare.IPC)

let stop: Stop | null = null
let readied = false
let exited = false

function ready() {
  if (readied) return
  readied = true
  void ipc.send('ready')
}

async function shutdown(code: number, err: unknown = null) {
  if (exited) return
  exited = true

  try {
    if (stop) await stop()
  } catch (error) {
    err = err ?? error
  }

  if (err) {
    const { message, stack } = err instanceof Error ? err : new Error(String(err))
    void ipc.send('error', { message, stack })
  }

  await ipc.send('exit', { code })
  Bare.exit(code)
}

ipc.on('terminate', () => void shutdown(0))
Bare.on('beforeExit', (code) => void shutdown(code))
Bare.on('uncaughtException', (err) => void shutdown(1, err))
Bare.on('unhandledRejection', (reason) => void shutdown(1, reason))

try {
  const entry = (await import(pathToFileURL(Bare.argv[2]!).href)) as { default: Start }
  stop = (await entry.default(ipc, ready)) ?? null
  ready()
} catch (err) {
  await shutdown(1, err)
}
