// Bare worker that handshakes, never replies, and exits cleanly on SIGTERM.
// Used by worker-close-inflight.test.ts to exercise close() with an in-flight call.

import RPC from 'bare-rpc'
import { connect } from 'bare-net'
import process from 'bare-process'

const { QVAC_IPC_SOCKET_PATH: socketPath } = JSON.parse(process.argv[2])

new RPC(connect(socketPath), () => {})

process.on('SIGTERM', () => process.exit(0))
