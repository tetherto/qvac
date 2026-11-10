import { runEntry } from '@/worker/shim'

if (!Bare.IPC) throw new Error('The unbundled worker runs under bare-sidecar, which opens Bare.IPC')

await runEntry(Bare.IPC, Bare.argv[2]!)
