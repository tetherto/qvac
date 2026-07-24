import type Supervisor from './index.js'

export default function stowEntry(
  build: (ipc: unknown) => Supervisor | Promise<Supervisor>
): (ipc: unknown, ready: () => void) => Promise<() => Promise<void>>
