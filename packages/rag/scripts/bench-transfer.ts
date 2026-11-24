// Measures export and import of the namespace bench-index.ts ingests: time,
// stream size, peak RSS and peak JS heap, each side in its own process. A flat
// heap across namespace sizes shows the stream holds no more than one frame
// (export) or one document (import); RSS also counts the database's caches.
//
//   npm run build
//   bare scripts/bench-index.ts ingest <dir> [--chunks 100000] [--dims 768]
//   bare scripts/bench-transfer.ts export <dir>   # writes <dir>/bench.qvragx
//   bare scripts/bench-transfer.ts import <dir>   # into a new store under <dir>/import
import fs from 'bare-fs'
import os from 'bare-os'
import Corestore from 'corestore'

import { createRag } from '../dist/index.js'

const READ_BYTES = 1024 * 1024

const [phase, dir] = Bare.argv.slice(2)
if ((phase !== 'export' && phase !== 'import') || !dir) {
  console.log('usage: bare scripts/bench-transfer.ts <export|import> <dir>')
  Bare.exit(phase === '--help' ? 0 : 1)
}
const file = `${dir}/bench.qvragx`

let peakHeap = 0
function sampleHeap(): void {
  peakHeap = Math.max(peakHeap, os.memoryUsage().heapUsed)
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MiB`
}

// libuv reports maxRSS in KiB on Linux and macOS.
function report(label: string, extra: Record<string, string>): void {
  const rss = os.memoryUsage().rss
  const peak = Math.max(rss, os.resourceUsage().maxRSS * 1024)
  sampleHeap()
  const memory = { rss: mib(rss), peakRss: mib(peak), peakHeap: mib(peakHeap) }
  console.log(JSON.stringify({ phase: label, ...memory, ...extra }))
}

async function* readFile(path: string): AsyncGenerator<Uint8Array> {
  const fd = fs.openSync(path, 'r')
  try {
    for (let position = 0; ;) {
      const buffer = new Uint8Array(READ_BYTES)
      const read = fs.readSync(fd, buffer, 0, READ_BYTES, position)
      if (read === 0) return
      position += read
      sampleHeap()
      yield buffer.subarray(0, read)
    }
  } finally {
    fs.closeSync(fd)
  }
}

if (phase === 'export') {
  const corestore = new Corestore(`${dir}/store`)
  const rag = createRag({ corestore })
  await rag.ready()
  const start = Date.now()
  const fd = fs.openSync(file, 'w')
  let bytes = 0
  for await (const part of rag.exportNamespace({ namespace: 'bench' })) {
    fs.writeSync(fd, part)
    bytes += part.byteLength
    sampleHeap()
  }
  fs.closeSync(fd)
  report('export', { bytes: mib(bytes), time: `${Date.now() - start} ms` })
  await rag.close()
  await corestore.close()
} else {
  fs.rmSync(`${dir}/import`, { recursive: true, force: true })
  const corestore = new Corestore(`${dir}/import/store`)
  const rag = createRag({ corestore })
  await rag.ready()
  const start = Date.now()
  const result = await rag.importNamespace({ namespace: 'bench', source: readFile(file) })
  const [summary] = await rag.listNamespaces()
  report('import', {
    documents: String(result.documents.length),
    chunks: String(summary.chunkCount),
    time: `${Date.now() - start} ms`
  })
  await rag.close()
  await corestore.close()
}
