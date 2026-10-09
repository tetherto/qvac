import RPC from 'bare-rpc'

export default function start(ipc) {
  new RPC(ipc, (req) => {
    if (JSON.parse(req.data.toString()).type === '__init_config') {
      req.reply(JSON.stringify({ success: true }), 'utf8')
      return
    }
    setTimeout(() => {
      throw new Error('QVAC_TEST_WORKER_THREW')
    }, 0)
  })
}
