'use strict'

// Worker env for the env shutdown test in id-map-index-async.test.js. Starts a
// long IVF build on one index, then a write on a second index, which waits
// behind the build on the addon's thread for long work. It then creates the
// ready file and idles, so the main env can terminate this env while the
// write is still waiting.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const IdMapIndex = require('@qvac/turbovec-ggml/idMapIndex')

const base = path.join(os.tmpdir(), `turbovec-ggml-teardown-${os.pid()}`)
const ROWS = 20_000
const DIM = 64

function randomRows(rows, dim) {
  const out = new Float32Array(rows * dim)
  let state = 0x5eed
  for (let i = 0; i < out.length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    out[i] = state / 0xffffffff - 0.5
  }
  return out
}

async function main() {
  const vectors = randomRows(ROWS, DIM)
  const ids = new BigUint64Array(ROWS)
  for (let i = 0; i < ROWS; i++) ids[i] = BigInt(i + 1)

  const busy = new IdMapIndex({ dim: DIM, bitWidth: 32 })
  await busy.addWithIds(vectors, ids)
  const small = new IdMapIndex({ dim: DIM, bitWidth: 32 })
  await small.addWithIds(vectors.subarray(0, DIM), new BigUint64Array([1n]))

  busy.buildIvf(256, 10).catch(() => {})
  small.write(`${base}.tvim`).catch(() => {})
  fs.writeFileSync(`${base}.ready`, 'ready')
}

main()
