import { type QvacConfig, type RuntimeContext } from '@qvac/inference/surface'
import type RPC from 'bare-rpc'
import {
  cleanupForTerminate,
  initialize,
  setConfig,
  setRuntimeContext
} from '@qvac/inference/engine'

// Internal config initialization (bypasses schema)
type InitConfigMessage = {
  type: '__init_config'
  config?: QvacConfig
  runtimeContext?: RuntimeContext
  homeDir?: string
}

export function isInitConfigMessage(data: unknown): data is InitConfigMessage {
  return (
    typeof data === 'object' && data !== null && 'type' in data && data.type === '__init_config'
  )
}

export function handleInitConfig(req: RPC.IncomingRequest, data: InitConfigMessage) {
  try {
    initialize({ homeDir: data.homeDir })
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
