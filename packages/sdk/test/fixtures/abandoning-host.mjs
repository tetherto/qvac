// Host that starts a worker, waits for ready, then exits without terminating it.

import Sidecar from 'bare-sidecar'
import host from 'bare-stow/host'

const [shim, entry] = process.argv.slice(2)

const ipc = new host.IPC(new Sidecar(shim, [entry], { stdio: 'inherit' }))
await ipc.ready
process.exit(0)
