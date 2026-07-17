// Bare-safe stub for the `#rpc` client transport. The SDK's RPC client is a
// Node/Electron/Expo concern; on Bare you use @qvac/inference directly, so the Bare
// worker bundle never invokes it. This exists only so bare-pack can resolve
// `#rpc` under the `bare` condition to a target free of `node:` builtins.
// TODO: revisit for a cleaner way to keep the client transport out of the worker bundle.

function notAvailable() {
  throw new Error('@qvac/sdk RPC client is not available on Bare; use @qvac/inference directly.')
}

export function getRPC() {
  return notAvailable()
}

export function createDuplexSession() {
  return notAvailable()
}

export function close() {
  return notAvailable()
}

export function getWorkerLifeSignal() {
  return null
}

export function notifyChannelClosed() {}
