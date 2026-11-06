import RPC from 'bare-rpc'
import { connect } from 'bare-net'
import Signal from 'bare-signals'
const { QVAC_IPC_SOCKET_PATH: socketPath } = JSON.parse(Bare.argv[2])
new RPC(connect(socketPath), (req) => {
  const request = JSON.parse(req.data.toString())
  if (request.type === '__init_config') {
    req.reply(JSON.stringify({ success: true }), 'utf-8')
  } else if (request.type === 'startRpcServer') {
    req.reply(
      JSON.stringify({
        type: request.type,
        serverId: JSON.stringify(request),
        url: `${request.host}:50052`,
        rdmaCapable: false
      }),
      'utf-8'
    )
  } else if (request.type === 'discoverRpcServers') {
    req.reply(
      JSON.stringify({
        type: request.type,
        servers: request.lanAddresses.map((address) => ({
          url: `${address}:50052`,
          rdmaAvailable: false,
          devices: [{ index: 0, freeMemory: 1, totalMemory: 2 }]
        }))
      }),
      'utf-8'
    )
  }
})
const signals = new Signal.Emitter()
signals.once('SIGTERM', () => Bare.exit(0))
