// Bare worker on the SDK's startWorker, with a timer standing in for the
// engine's open handles so the process does not end on its own.

import os from 'bare-os'
import { setInterval } from 'bare-timers'
import { startWorker } from '../../dist/src/worker/start.js'

export default function start(ipc, ready) {
  setInterval(() => {}, 1_000)
  console.log(`worker-pid ${os.pid()}`)
  return startWorker(ipc, ready, { plugins: [] })
}
