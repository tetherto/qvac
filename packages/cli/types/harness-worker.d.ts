declare module '@qvac/harness/worker/harness-sidecar.mjs' {
  import type { HarnessSidecar } from '@qvac/harness/sidecar'

  const start: (
    ipc: Parameters<typeof HarnessSidecar.start>[0],
    ready: Parameters<typeof HarnessSidecar.start>[1]
  ) => ReturnType<typeof HarnessSidecar.start>
  export default start
}
