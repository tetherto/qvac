import RPC from 'bare-rpc'
import os from 'bare-os'

export default function start(ipc) {
  new RPC(ipc, (req) => {
    if (JSON.parse(req.data.toString()).type === '__init_config') {
      req.reply(JSON.stringify({ success: true }), 'utf8')
      return
    }
    os.kill(os.pid(), 'SIGKILL')
  })
}
