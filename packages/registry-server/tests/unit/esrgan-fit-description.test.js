'use strict'

const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { gguf } = require('@huggingface/gguf')
const { fitBlobContent, writeFitBlob, supportsFitBlob } = require('../../lib/fit-blob')
const { crc32, readTorchZip } = require('../../lib/fit-description/torch-zip')
const { withFileCursor } = require('../../lib/fit-description/file-cursor')
const { parseTorchPickle } = require('../../lib/fit-description/torch-pickle')
const {
  buildPth,
  buildZip,
  buildTorchPickle,
  DEFAULT_ESRGAN_TENSORS
} = require('../helpers/pth-fixture')

const ENGINE = '@qvac/diffusion-cpp'

function fixture(t, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esrgan-fit-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'model.pth')
  fs.writeFileSync(file, bytes)
  return { dir, file }
}

test('ESRGAN .pth descriptions are selected only for the diffusion engine', (t) => {
  t.ok(supportsFitBlob('model.PTH', ENGINE))
  t.absent(supportsFitBlob('model.pth'))
  t.absent(supportsFitBlob('model.pth', '@qvac/transcription-whispercpp'))
  t.is(crc32(Buffer.from('123456789')), 0xcbf43926, 'standard ZIP CRC-32')
})

for (const [storageType, dtype] of [
  ['FloatStorage', 0],
  ['HalfStorage', 1]
]) {
  test(`a ${storageType} checkpoint becomes a weightless tensor inventory`, async (t) => {
    const artifact = buildPth({ storageType })
    const { dir, file } = fixture(t, artifact)
    const result = await writeFitBlob(file, dir, ENGINE)
    t.ok(result, 'a fit blob was written')
    const parsed = await gguf(result.path, { allowLocalFile: true })
    t.is(parsed.metadata['general.architecture'], 'esrgan')
    t.is(Number(parsed.metadata['fit_description.source_size']), artifact.length)
    t.alike(
      parsed.tensorInfos.map((info) => ({
        name: info.name,
        type: info.dtype,
        shape: info.shape.map(Number)
      })),
      DEFAULT_ESRGAN_TENSORS.map((tensor) => ({
        name: tensor.name,
        type: dtype,
        shape: [...tensor.shape].reverse()
      }))
    )
    t.is(Number(parsed.tensorDataOffset), result.size, 'there is no tensor payload')
    const second = await fitBlobContent(file, ENGINE)
    t.alike(second, fs.readFileSync(result.path), 'description bytes are deterministic')
  })
}

test('the reader fetches ZIP headers and pickle metadata, not tensor payloads', async (t) => {
  const artifact = buildPth({ storageBytes: 1024 * 1024 })
  const { file } = fixture(t, artifact)
  let readBytes = 0
  await withFileCursor(file, async (cursor) => {
    const handle = {
      read: async (...args) => {
        const result = await cursor.handle.read(...args)
        readBytes += result.bytesRead
        return result
      }
    }
    const archive = await readTorchZip(handle, cursor.size)
    t.ok(archive.bytes.length > 0)
  })
  t.ok(readBytes < 100000, `read ${readBytes} bytes from a ${artifact.length}-byte archive`)
})

const invalid = [
  ['truncated ZIP', () => buildPth().subarray(0, -10)],
  ['missing storage', () => buildZip([['archive/data.pkl', buildTorchPickle()]])],
  ['short storage', () => buildPth({ storageBytes: 1 })],
  [
    'non-contiguous tensor',
    () => buildPth({ tensors: [{ ...DEFAULT_ESRGAN_TENSORS[0], stride: [1, 1, 1, 1] }] })
  ],
  ['storage overflow', () => buildPth({ tensors: [{ ...DEFAULT_ESRGAN_TENSORS[0], offset: 1 }] })],
  ['unsupported storage type', () => buildPth({ storageType: 'DoubleStorage' })],
  [
    'non-ESRGAN tensor names',
    () => buildPth({ tensors: [{ name: 'other.weight', shape: [2, 2] }] })
  ],
  [
    'duplicate ZIP entries',
    () =>
      buildZip([
        ['archive/data.pkl', buildTorchPickle()],
        ['archive/data.pkl', buildTorchPickle()]
      ])
  ],
  [
    'executable global',
    () =>
      buildPth({ pickle: Buffer.concat([Buffer.from([0x80, 2]), Buffer.from('cos\nsystem\n.')]) })
  ],
  [
    'unsupported protocol',
    () => {
      const bytes = buildTorchPickle()
      bytes[1] = 5
      return buildPth({ pickle: bytes })
    }
  ],
  [
    'bytes after pickle STOP',
    () => buildPth({ pickle: Buffer.concat([buildTorchPickle(), Buffer.from('x')]) })
  ]
]

for (const [name, build] of invalid) {
  test(`${name} yields no fit description`, async (t) => {
    const { dir, file } = fixture(t, build())
    t.is(await writeFitBlob(file, dir, ENGINE), null)
  })
}

test('corrupt pickle metadata is rejected by its archive checksum', async (t) => {
  const bytes = buildPth()
  const start = 30 + Buffer.byteLength('archive/data.pkl')
  bytes[start + 2] ^= 1
  const { dir, file } = fixture(t, bytes)
  t.is(await writeFitBlob(file, dir, ENGINE), null)
})

test('pickle stack and memo operations validate their operands', (t) => {
  for (const bytes of [
    Buffer.from([0x80, 2, 0x68, 99]),
    Buffer.from([0x80, 2, 0x75]),
    Buffer.from([0x80, 2, 0x85])
  ]) {
    t.exception(() => parseTorchPickle(bytes))
  }
})

test('pickle globals are never executed', (t) => {
  const bytes = Buffer.concat([Buffer.from([0x80, 2]), Buffer.from('cos\nsystem\n.')])
  t.exception(() => parseTorchPickle(bytes), /unsupported pickle global os.system/)
})

test('memo references and OrderedDict BUILD metadata preserve the tensor inventory', async (t) => {
  const pickle = buildTorchPickle(DEFAULT_ESRGAN_TENSORS, 'FloatStorage', true)
  const { dir, file } = fixture(t, buildPth({ pickle }))
  const blob = await writeFitBlob(file, dir, ENGINE)
  t.ok(blob, 'memoized protocol-2 state dictionary is described')
  const parsed = await gguf(blob.path, { allowLocalFile: true })
  t.alike(
    parsed.tensorInfos.map((info) => info.name),
    DEFAULT_ESRGAN_TENSORS.map((tensor) => tensor.name)
  )
})
