export function rpcTimeout(cause?: unknown): Error {
  return new Error(
    'RPC initialization timed out after 30000ms — the worker process may have failed to start',
    { cause }
  )
}
