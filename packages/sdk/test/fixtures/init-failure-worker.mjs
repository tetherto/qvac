import RPC from 'bare-rpc'

export default function start(ipc) {
  new RPC(ipc, (req) => {
    req.reply(JSON.stringify({ success: false, error: 'initialize failed' }), 'utf8')
  })
}
