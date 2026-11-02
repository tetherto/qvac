import type { RpcServerProvider } from '@/schemas/rpc-server'
import { RpcServerOperationError } from '@/errors/index'

let provider: RpcServerProvider | undefined

/** Register the native server implementation explicitly, without loading any model plugin. */
export function registerRpcServerProvider(value: RpcServerProvider): void {
  if (!value || typeof value.start !== 'function') {
    throw new RpcServerOperationError('registerRpcServerProvider', 'Provider must define start()')
  }
  if (provider) {
    throw new RpcServerOperationError(
      'registerRpcServerProvider',
      'A provider is already registered'
    )
  }
  provider = value
}

export function hasRpcServerProvider(): boolean {
  return provider !== undefined
}

export function getRpcServerProvider(): RpcServerProvider {
  if (!provider) {
    throw new RpcServerOperationError(
      'startRpcServer',
      'No RPC server provider registered. Register a provider in Bare or select rpcServerProvider when bundling the SDK worker.'
    )
  }
  return provider
}

export function clearRpcServerProvider(): void {
  provider = undefined
}
