import host from 'bare-stow/host'
import { fileURLToPath } from 'node:url'

type WorkerIPC = InstanceType<typeof host.IPC>

function unbundledShim(): string {
  type ImportMetaAsset = { asset?: (spec: string) => string }
  const asset = (import.meta as ImportMetaAsset).asset
  return fileURLToPath(
    asset
      ? asset('../../worker/unbundled-shim.js')
      : new URL('../../worker/unbundled-shim.js', import.meta.url)
  )
}

export async function start(
  entry: string,
  options: { timeout?: number } = {}
): Promise<{ ipc: WorkerIPC }> {
  const { default: Sidecar } = await import('bare-sidecar')
  const ipc = new host.IPC(new Sidecar(unbundledShim(), [entry], { stdio: 'inherit' }), options)
  await ipc.ready
  return { ipc }
}
