import type { QvacConfig, RuntimeContext } from '@qvac/inference/surface'
import { getClientLogger, setGlobalLogLevel, setGlobalConsoleOutput } from '@/logging'
import { SetConfigFailedError } from '@/utils/errors-client'

const logger = getClientLogger()

type ResolveConfigFn = () => Promise<QvacConfig | undefined>

// Minimal RPC interface for config initialization
// Using loose types to avoid Buffer type conflicts between Node/Bare runtimes
interface RPCClient {
  request(command: number): any
}

function applyClientLoggerSettings(config: QvacConfig) {
  if (config.loggerLevel !== undefined) {
    setGlobalLogLevel(config.loggerLevel)
  }
  if (config.loggerConsoleOutput !== undefined) {
    setGlobalConsoleOutput(config.loggerConsoleOutput)
  }
}

async function sendInitMessage(
  rpc: RPCClient,
  config: QvacConfig | undefined,
  runtimeContext: RuntimeContext,
  homeDir: string
) {
  const initMessage = {
    type: '__init_config',
    config,
    runtimeContext,
    homeDir
  }

  const req = rpc.request(1)
  req.send(JSON.stringify(initMessage), 'utf8')
  const response = await req.reply('utf8')
  const parsed = JSON.parse(response.toString()) as {
    success: boolean
    error?: string
  }

  if (!parsed.success) {
    throw new SetConfigFailedError(parsed.error ?? 'Unknown error')
  }
}

/**
 * Sends the worker its first message: config, runtime context and the folder
 * that holds `.qvac`. Config is loaded once and becomes immutable on the
 * worker side.
 *
 * @param rpc - The RPC client instance
 * @param resolveConfig - Runtime-specific config resolver function
 * @param runtimeContext - Runtime context (platform, device info)
 * @param homeDir - Folder the worker keeps `.qvac` in
 */
export async function initializeConfig(
  rpc: RPCClient,
  resolveConfig: ResolveConfigFn,
  runtimeContext: RuntimeContext,
  homeDir: string
) {
  const config = await resolveConfig()

  if (config) {
    applyClientLoggerSettings(config)
    logger.info('📦 Initializing SDK config')
  }

  logger.info('📱 Runtime context:', runtimeContext)

  try {
    await sendInitMessage(rpc, config, runtimeContext, homeDir)
    logger.info('✅ Initialization complete')
  } catch (error) {
    logger.error('❌ Initialization failed:', error)
  }
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use initializeConfig instead
 */
export function replayConfigIfCached() {
  logger.warn(
    '⚠️ replayConfigIfCached is deprecated and has no effect. Config is now loaded from file during initialization.'
  )
}
