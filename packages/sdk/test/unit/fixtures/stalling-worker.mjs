// Bare worker that handshakes, never replies, and exits cleanly on SIGTERM.
// Used by worker-close-inflight.test.ts to exercise close() with an in-flight call.

import RPC from 'bare-rpc'
import { connect } from 'bare-net'
import Signal from 'bare-signals'

const { QVAC_IPC_SOCKET_PATH: socketPath } = JSON.parse(Bare.argv[2])

new RPC(connect(socketPath), () => {})

const signals = new Signal.Emitter()
signals.once('SIGTERM', () => Bare.exit(0))
