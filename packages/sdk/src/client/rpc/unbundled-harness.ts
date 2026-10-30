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
  const sidecar = new Sidecar(unbundledShim(), [entry], { stdio: 'inherit' })
  const ipc = host.wrap(sidecar, { ...options, kill: () => sidecar.kill('SIGKILL') })
  sidecar.on('exit', (code, signal) => ipc.exited(code, signal))
  await ipc.ready
  return { ipc }
}
