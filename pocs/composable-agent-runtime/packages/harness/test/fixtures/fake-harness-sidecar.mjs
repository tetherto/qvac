import { createHarness, serveHarness } from '../../index.ts'

export default async function start(ipc, ready) {
  serveHarness(
    ipc,
    createHarness({
      sdk: {
        loadModel: async ({ model }) => ({ modelId: model }),
        completion: ({ requestId }) => ({
          requestId,
          events: (async function* () {
            yield { type: 'content-delta', text: 'spawned' }
          })()
        }),
        cancel: async () => {},
        heartbeat: async () => ({ ok: true }),
        close: async () => {}
      }
    })
  )
  ready()
}
