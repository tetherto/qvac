// Bare worker that signals ready and never replies to a request.
// Used by worker-close-inflight.test.ts to exercise close() with an in-flight call.

import RPC from 'bare-rpc'

export default function start(ipc) {
  new RPC(ipc, () => {})
}
