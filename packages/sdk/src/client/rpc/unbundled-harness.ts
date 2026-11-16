import { wrap, type IPC } from 'bare-stow-host'
import { fileURLToPath } from 'node:url'
import type { WorkerProcess } from './worker-failure'

function unbundledShim(): string {
  type ImportMetaAsset = { asset?: (spec: string) => string }
  const asset = (import.meta as ImportMetaAsset).asset
  return fileURLToPath(
    asset
      ? asset('../../worker/unbundled-shim.js')
      : new URL('../../worker/unbundled-shim.js', import.meta.url)
  )
}

/**
 * Starts a worker entry without a bundle on bare-sidecar, wrapped by
 * bare-stow-host. The worker's stderr goes to `onStderr`, and the spawned
 * sidecar to `onSpawn`.
 */
export async function start(
  entry: string,
  options: {
    timeout?: number
    grace?: number
    onStderr?: (chunk: unknown) => void
    onSpawn?: (sidecar: WorkerProcess) => void
  } = {}
): Promise<{ ipc: IPC }> {
  const { onStderr, onSpawn, ...ipcOptions } = options
  const { default: Sidecar } = await import('bare-sidecar')
  const sidecar = new Sidecar(unbundledShim(), [entry], {
    stdio: ['inherit', 'inherit', onStderr ? 'pipe' : 'inherit']
  })
  if (onStderr) sidecar.stderr?.on('data', onStderr)
  onSpawn?.(sidecar)
  const ipc = wrap(sidecar, { ...ipcOptions, kill: () => sidecar.kill('SIGKILL') })
  sidecar.on('exit', (code, signal) => ipc.exited(code, signal))
  await ipc.ready
  return { ipc }
}
