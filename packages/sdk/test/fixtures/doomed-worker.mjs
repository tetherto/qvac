// Bare worker that handshakes, swallows every RPC, then exits 100ms later.

import RPC from 'bare-rpc'
import { connect } from 'bare-net'

const { QVAC_IPC_SOCKET_PATH: socketPath } = JSON.parse(Bare.argv[2])

new RPC(connect(socketPath), () => {})

setTimeout(() => Bare.exit(1), 100)
