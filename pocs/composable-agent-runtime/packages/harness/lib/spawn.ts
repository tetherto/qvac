import { connectHarness } from './connect.ts'
import type { RemoteHarness } from './connect.ts'

export interface SpawnHarnessOptions {
  readonly entry: string
  readonly args?: readonly string[]
}

export interface HarnessSidecarExit {
  readonly code: number | null
  readonly signal: string | null
}

export interface SpawnedHarness extends RemoteHarness {
  readonly exited: Promise<HarnessSidecarExit>
  forceTerminate(): Promise<HarnessSidecarExit>
}

export function spawnHarness({
  entry,
  args = []
}: SpawnHarnessOptions): SpawnedHarness {
  let child:
    | {
        destroy(error?: Error): void
        once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
      }
    | null = null
  let childExit: Promise<HarnessSidecarExit> | null = null
  let resolveExit: (exit: HarnessSidecarExit) => void = () => {}
  const exited = new Promise<HarnessSidecarExit>((resolve) => {
    resolveExit = resolve
  })
  const remote = connectHarness(async () => {
    const [sidecarModule, stowHost] = await Promise.all([
      import('bare-sidecar'),
      import('bare-stow/host')
    ])
    const Sidecar = sidecarModule.default
    const nextChild = new Sidecar(entry, [...args])
    child = nextChild
    childExit = new Promise((resolve) => {
      nextChild.once('exit', (code, signal) => {
        const exit = { code, signal }
        resolve(exit)
        resolveExit(exit)
      })
    })
    nextChild.stdout?.on('data', () => {})
    nextChild.stderr?.on('data', () => {})
    const ipc = wrapSidecar(stowHost, nextChild)
    const earlyExit = new Promise<never>((_resolve, reject) => {
      nextChild.once('exit', (code) => reject(new Error(`harness exited (${code}) before ready`)))
    })
    await Promise.race([ipc.ready, earlyExit])
    return ipc
  })
  const closeRemote = remote.close.bind(remote)
  return Object.assign(remote, {
    exited,
    async close() {
      await closeRemote()
      if (childExit) await childExit
    },
    async forceTerminate() {
      if (!child || !childExit) throw new Error('harness sidecar has not started')
      const currentExit = childExit
      child.destroy(new Error('forced Harness termination'))
      return currentExit
    }
  }) as SpawnedHarness
}

function wrapSidecar(module: object, child: object) {
  const named = Reflect.get(module, 'wrap')
  if (typeof named === 'function') return named(child)
  const nested = Reflect.get(Reflect.get(module, 'default') ?? {}, 'wrap')
  if (typeof nested === 'function') return nested(child)
  throw new Error('bare-stow/host does not export wrap')
}
