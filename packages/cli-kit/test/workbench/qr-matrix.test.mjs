import assert from 'node:assert/strict'
import { it } from 'node:test'
import { qrLines } from '../../dist/product/qr.js'
import qrcode from '../../dist/lib/vendor/qrcode.mjs'

it('terminal QR output preserves every matrix cell and complete quiet zone', () => {
  const input = 'pear://abcdefghijklmnopqrstuv1234567890'
  const qr = qrcode(0, 'L')
  qr.addData(input.toUpperCase(), 'Alphanumeric')
  qr.make()
  const lines = qrLines(input, { color: false })
  const size = qr.getModuleCount()
  const width = size + 8
  assert.equal(lines.length, Math.ceil(width / 2))
  for (const line of lines) assert.equal(line.length, width)
  const blocks = [' ', '▄', '▀', '█']
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const bits = blocks.indexOf(lines[Math.floor(y / 2)]?.[x])
      const dark = (bits & (y % 2 ? 1 : 2)) !== 0
      const expected = x >= 4 && y >= 4 && x < size + 4 && y < size + 4 && qr.isDark(y - 4, x - 4)
      assert.equal(dark, expected, `${x},${y}`)
    }
  }
  assert.deepEqual(qrLines(input, { color: false }), qrLines(input.toUpperCase(), { color: false }))
  assert.deepEqual(
    qrLines(input),
    lines.map((line) => '\x1b[30;47m' + line + '\x1b[0m')
  )
})
