// Canonical bytes come from the locked upstream implementation, not the Kotlin codec.
const fs = require('node:fs')
const path = require('node:path')
const c = require('compact-encoding')
const rpcRoot = path.dirname(require.resolve('bare-rpc'))
const m = require(path.join(rpcRoot, 'lib/messages'))
const { type: t, stream: s } = require(path.join(rpcRoot, 'lib/constants'))
const messages = [
  { type: t.REQUEST, id: 0, command: 0, stream: 0, data: Buffer.alloc(0) },
  { type: t.REQUEST, id: 253, command: 65536, stream: 0, data: Buffer.from('hello 🌍') },
  { type: t.RESPONSE, id: 65536, stream: 0, data: Buffer.from([0, 1, 255]) },
  { type: t.RESPONSE, id: 1, stream: 0, error: { message: 'failed', code: 'E_TEST', errno: -42 } },
  { type: t.REQUEST, id: 2, command: 0, stream: s.OPEN },
  { type: t.RESPONSE, id: 2, stream: s.OPEN }
]
for (const direction of [s.REQUEST, s.RESPONSE]) {
  for (const flag of [s.OPEN, s.CLOSE, s.PAUSE, s.RESUME, s.DATA, s.END, s.DESTROY, s.DESTROY | s.ERROR]) {
    messages.push({ type: t.STREAM, id: 2, stream: direction | flag,
      ...(flag & s.DATA ? { data: Buffer.from('chunk') } : {}),
      ...(flag & s.ERROR ? { error: { message: 'cancelled', code: 'ERR_CANCEL', errno: -1 } } : {}) })
  }
}
const result = {
  // Only the wire bytes are committed; the upstream lib versions are omitted so
  // the fixture stays stable without a pinned lockfile. The byte format does not
  // change across bare-rpc / compact-encoding versions.
  frames: messages.map(message => {
    const bytes = Buffer.concat([c.encode(m.header, message), message.data || Buffer.alloc(0)])
    // Also exercise the actual upstream decoder before committing a vector.
    m.message.decode(c.state(0, bytes.length, bytes))
    return { type: message.type, id: message.id, hex: bytes.toString('hex') }
  }),
  uints: [0, 252, 253, 65535, 65536, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER]
    .map(value => ({ value, hex: c.encode(c.uint, value).toString('hex') })),
  ints: [-4294967296, -65536, -253, -1, 0, 1, 253, 65536, 4294967296]
    .map(value => ({ value, hex: c.encode(c.int, value).toString('hex') }))
}
const target = path.join(__dirname, '..', 'test-fixtures', 'bare-rpc.json')
const output = JSON.stringify(result, null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== output) throw new Error('Bare-RPC wire fixtures are stale')
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, output)
}
