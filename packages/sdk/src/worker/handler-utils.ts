import { type QvacConfig, type RuntimeContext } from '@qvac/core/surface'
import type RPC from 'bare-rpc'
import { setConfig, setRuntimeContext } from '@qvac/core/engine'

// Internal config initialization (bypasses schema)
type InitConfigMessage = {
  type: '__init_config'
  config: QvacConfig
  runtimeContext?: RuntimeContext
}

export function isInitConfigMessage(data: unknown): data is InitConfigMessage {
  return (
    typeof data === 'object' && data !== null && 'type' in data && data.type === '__init_config'
  )
}

export function handleInitConfig(req: RPC.IncomingRequest, data: InitConfigMessage) {
  try {
    if (data.config) {
      setConfig(data.config)
    }
    if (data.runtimeContext) {
      setRuntimeContext(data.runtimeContext)
    }
    req.reply(JSON.stringify({ success: true }), 'utf-8')
  } catch (error) {
    req.reply(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }),
      'utf-8'
    )
  }
}

// Internal pre-terminate cleanup signal. The SDK client sends this before
// tearing down the bare runtime (e.g. Worklet.terminate() on mobile) so
// addons can release env-bound state while their JS environment is still
// alive. Reply success/failure, never throws to the dispatcher.
type ShutdownMessage = {
  type: '__shutdown__'
}

export function isShutdownMessage(data: unknown): data is ShutdownMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as { type?: unknown }).type === '__shutdown__'
  )
}

export async function handleShutdown(req: RPC.IncomingRequest): Promise<void> {
  try {
    const { cleanupForTerminate } = await import('@/server/worker-core')
    await cleanupForTerminate()
    req.reply(JSON.stringify({ success: true }), 'utf-8')
  } catch (error) {
    req.reply(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }),
      'utf-8'
    )
  }
}
