/**
 * Browser worker entry: the Bare worker's request handling, run in a
 * Dedicated Worker over its postMessage channel. Prebuilt into
 * `dist/worker.browser.js` (scripts/build-browser-worker.mjs) and started by
 * the browser `#rpc` client. Registers the plugins whose addons have a browser
 * build.
 */
import RPC from 'bare-rpc'
import { prepareBrowserRuntime } from '@qvac/inference/browser'
import { initialize } from '@qvac/inference/engine'
import { registerPlugins } from '@qvac/inference/plugins'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'
import { handleRequest } from '@/worker/handle-request'
import { getServerLogger } from '@/logging'
import { createWorkerPortStream, type WorkerPort } from '@/utils/worker-port-stream'

// Created first so requests sent while the file system index loads are
// buffered rather than lost.
const ipc = createWorkerPortStream(globalThis as unknown as WorkerPort)

await prepareBrowserRuntime()
initialize()
registerPlugins([llmPlugin])

new RPC(ipc, handleRequest)
getServerLogger().info('Browser worker ready')
