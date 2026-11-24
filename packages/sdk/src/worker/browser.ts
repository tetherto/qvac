import { close as closeEngine } from '@qvac/inference/engine'
import { prepareBrowserRuntime } from '@qvac/inference/browser'
import { registerPlugins } from '@qvac/inference/plugins'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'
import { getServerLogger } from '@/logging'
import { handleRequest } from '@/worker/handle-request'
import { createWorkerRpc } from '@/server/rpc/rpc-utils'
import { createWorkerPortStream, type WorkerPort } from '@/utils/worker-port-stream'
import { mountBrowserFileGroup, type BrowserFileMount } from './browser-file-mount'

interface ControlMessage {
  type: 'qvac:mount-files' | 'qvac:close'
  id: number
  files?: BrowserFileMount[]
}

const port = globalThis as unknown as WorkerPort
const ipc = createWorkerPortStream(port)
const runtimeReady = prepareBrowserRuntime()

port.addEventListener('message', (event) => {
  const message = event.data as Partial<ControlMessage> | null
  if (
    (message?.type !== 'qvac:mount-files' && message?.type !== 'qvac:close') ||
    typeof message.id !== 'number'
  ) {
    return
  }

  void (async () => {
    try {
      await runtimeReady
      if (message.type === 'qvac:mount-files') {
        if (!Array.isArray(message.files)) {
          throw new Error('Invalid browser file mount request')
        }
        mountBrowserFileGroup(message.files)
      } else {
        await closeEngine()
      }
      port.postMessage({ type: 'qvac:control-result', id: message.id }, [])
    } catch (error) {
      port.postMessage(
        {
          type: 'qvac:control-result',
          id: message.id,
          error: error instanceof Error ? error.message : String(error)
        },
        []
      )
    }
  })()
})

await runtimeReady
registerPlugins([llmPlugin])
createWorkerRpc(ipc, handleRequest)
getServerLogger().info('Browser worker ready')
