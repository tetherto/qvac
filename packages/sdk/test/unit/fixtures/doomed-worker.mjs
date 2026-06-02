// Bare worker that handshakes, swallows every RPC, then exits 100ms later.

import RPC from 'bare-rpc'
import { connect } from 'bare-net'
import process from 'bare-process'

const { QVAC_IPC_SOCKET_PATH: socketPath } = JSON.parse(process.argv[2])

new RPC(connect(socketPath), () => {})

setTimeout(() => process.exit(1), 100)
