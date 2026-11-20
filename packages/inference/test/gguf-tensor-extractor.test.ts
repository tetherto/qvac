import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Buffer from 'bare-buffer'
import { extractAndWriteTensorsFile, hasValidGGUFHeader } from '@/utils/gguf-tensor-extractor'

const u32 = (value: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value, 0)
  return b
}
const u64 = (value: number) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(value), 0)
  return b
}
const str = (value: string) => {
  const b = Buffer.from(value)
  return Buffer.concat([u64(b.length), b])
}

// A GGUF v3 header: a string-array KV of `vocab` entries (the tokenizer
// vocabulary dominates real headers), then `tensors` tensor infos.
function ggufHeader(vocab: number, tensors: string[]): Buffer {
  const tokens: Buffer[] = []
  for (let i = 0; i < vocab; i++) tokens.push(str(`token-${i}`))
  const infos = tensors.map((name, i) =>
    Buffer.concat([str(name), u32(1), u64(16), u32(0), u64(i * 64)])
  )
  return Buffer.concat([
    Buffer.from('GGUF'),
    u32(3),
    u64(tensors.length),
    u64(1),
    str('tokenizer.ggml.tokens'),
    u32(9),
    u32(8),
    u64(vocab),
    ...tokens,
    ...infos
  ])
}

function tempDir(t: { teardown: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-extractor-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const TENSORS = ['token_embd.weight', 'blk.0.attn_q.weight', 'output.weight']

test('extractAndWriteTensorsFile: reads tensor names from a header spanning many read chunks', async (t) => {
  const dir = tempDir(t)
  // ~1.3 MB header: far more than one stream chunk and the initial buffer.
  fs.writeFileSync(
    path.join(dir, 'model-00001-of-00001.gguf'),
    Buffer.concat([ggufHeader(80_000, TENSORS), Buffer.alloc(4096)])
  )

  const file = await extractAndWriteTensorsFile(dir, ['model-00001-of-00001.gguf'], 'model')

  t.alike(fs.readFileSync(file, 'utf8').trim().split('\n'), [...TENSORS].sort())
})

test('hasValidGGUFHeader: a header that ends exactly at end of file is valid', async (t) => {
  const file = path.join(tempDir(t), 'exact.gguf')
  fs.writeFileSync(file, ggufHeader(80_000, TENSORS))

  t.ok(await hasValidGGUFHeader(file))
})

test('hasValidGGUFHeader: a file cut inside the header is not valid', async (t) => {
  const file = path.join(tempDir(t), 'truncated.gguf')
  const header = ggufHeader(80_000, TENSORS)
  fs.writeFileSync(file, header.subarray(0, header.length - 10))

  t.absent(await hasValidGGUFHeader(file))
})

test('hasValidGGUFHeader: a file shorter than the fixed header fields is not valid', async (t) => {
  const file = path.join(tempDir(t), 'tiny.gguf')
  fs.writeFileSync(file, Buffer.from('GGUF'))

  t.absent(await hasValidGGUFHeader(file))
})
