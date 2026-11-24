import { mkdir, writeFile } from 'node:fs/promises'
import { buildCapabilityBaseline } from './contract/build-capability-baseline'

// Writes the capability baseline into the build output, so the published
// package carries the contracts it was released with. Run by `npm run build`.
const file = new URL('../dist/contract/capability-baseline.json', import.meta.url)
await mkdir(new URL('.', file), { recursive: true })
await writeFile(file, `${JSON.stringify(buildCapabilityBaseline())}\n`)
console.log('wrote dist/contract/capability-baseline.json')
