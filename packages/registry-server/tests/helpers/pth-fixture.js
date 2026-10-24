'use strict'

const { crc32 } = require('../../lib/fit-description/torch-zip')

const DEFAULT_ESRGAN_TENSORS = [
  { name: 'conv_first.weight', shape: [4, 3, 3, 3] },
  { name: 'conv_first.bias', shape: [4] },
  { name: 'conv_last.weight', shape: [3, 4, 3, 3] },
  { name: 'conv_last.bias', shape: [3] }
]

function u16(value) {
  const result = Buffer.alloc(2)
  result.writeUInt16LE(value)
  return result
}

function u32(value) {
  const result = Buffer.alloc(4)
  result.writeUInt32LE(value)
  return result
}

function unicode(value) {
  const bytes = Buffer.from(value)
  return Buffer.concat([Buffer.from('X'), u32(bytes.length), bytes])
}

function integer(value) {
  const bytes = Buffer.alloc(5)
  bytes[0] = 0x4a
  bytes.writeInt32LE(value, 1)
  return bytes
}

function tuple(parts) {
  return Buffer.concat([Buffer.from('('), ...parts, Buffer.from('t')])
}

function global(name) {
  const separator = name.lastIndexOf('.')
  return Buffer.from(`c${name.slice(0, separator)}\n${name.slice(separator + 1)}\n`)
}

function memoGlobal(name, key, first) {
  const put = key < 256 ? Buffer.from([0x71, key]) : Buffer.concat([Buffer.from('r'), u32(key)])
  const get = key < 256 ? Buffer.from([0x68, key]) : Buffer.concat([Buffer.from('j'), u32(key)])
  return first ? Buffer.concat([global(name), put]) : get
}

function tensorPickle(tensor, index, storageType, memo) {
  const shape = tensor.shape
  const stride = shape.map((_, dim) => shape.slice(dim + 1).reduce((a, b) => a * b, 1))
  const storage = tuple([
    unicode('storage'),
    memo ? memoGlobal(`torch.${storageType}`, 3, index === 0) : global(`torch.${storageType}`),
    unicode(String(index)),
    unicode('cpu'),
    integer(tensor.count ?? shape.reduce((a, b) => a * b, 1))
  ])
  const args = tuple([
    Buffer.concat([storage, Buffer.from('Q')]),
    integer(tensor.offset ?? 0),
    tuple(shape.map(integer)),
    tuple((tensor.stride ?? stride).map(integer)),
    Buffer.from([0x89]),
    Buffer.concat([
      memo ? Buffer.from([0x68, 2]) : global('collections.OrderedDict'),
      Buffer.from(')R')
    ])
  ])
  return Buffer.concat([
    unicode(tensor.name),
    memo
      ? memoGlobal('torch._utils._rebuild_tensor_v2', 300, index === 0)
      : global('torch._utils._rebuild_tensor_v2'),
    args,
    Buffer.from('R')
  ])
}

function buildTorchPickle(
  tensors = DEFAULT_ESRGAN_TENSORS,
  storageType = 'FloatStorage',
  memo = false
) {
  return Buffer.concat([
    Buffer.from([0x80, 2, 0x7d]),
    unicode('params_ema'),
    memo ? memoGlobal('collections.OrderedDict', 2, true) : global('collections.OrderedDict'),
    Buffer.from(')R('),
    ...tensors.map((tensor, index) => tensorPickle(tensor, index, storageType, memo)),
    Buffer.from('u'),
    ...(memo ? [Buffer.from('}'), unicode('_metadata'), Buffer.from('}sb')] : []),
    Buffer.from('s.')
  ])
}

function buildZip(entries) {
  const locals = []
  const directory = []
  let offset = 0
  for (const [name, bytes] of entries) {
    const filename = Buffer.from(name)
    const crc = crc32(bytes)
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u32(0),
      u32(crc),
      u32(bytes.length),
      u32(bytes.length),
      u16(filename.length),
      u16(0),
      filename,
      bytes
    ])
    directory.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u32(0),
        u32(crc),
        u32(bytes.length),
        u32(bytes.length),
        u16(filename.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        filename
      ])
    )
    locals.push(local)
    offset += local.length
  }
  const central = Buffer.concat(directory)
  return Buffer.concat([
    ...locals,
    central,
    u32(0x06054b50),
    u32(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0)
  ])
}

function buildPth({
  tensors = DEFAULT_ESRGAN_TENSORS,
  storageType = 'FloatStorage',
  pickle,
  storageBytes
} = {}) {
  const byteLength = storageType === 'HalfStorage' ? 2 : 4
  return buildZip([
    ['archive/data.pkl', pickle ?? buildTorchPickle(tensors, storageType)],
    ...tensors.map((tensor, index) => [
      `archive/data/${index}`,
      Buffer.alloc(storageBytes ?? tensor.shape.reduce((a, b) => a * b, byteLength))
    ])
  ])
}

module.exports = { buildPth, buildZip, buildTorchPickle, DEFAULT_ESRGAN_TENSORS }
