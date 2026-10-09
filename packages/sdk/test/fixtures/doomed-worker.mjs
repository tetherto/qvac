// Bare worker that signals ready, swallows every request, then exits 100ms later.

import RPC from 'bare-rpc'

export default function start(ipc) {
  new RPC(ipc, () => {})
  setTimeout(() => Bare.exit(1), 100)
}
