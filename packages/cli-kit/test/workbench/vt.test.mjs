// The test screen itself: a pty test is only as good as its terminal.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Screen } from './helpers/vt.mjs'

test('a full row wraps only when the next glyph comes, and the last row scrolls', () => {
  const s = new Screen(2, 3)
  s.write('abc\r\ndef')
  assert.equal(s.text(), 'abc\ndef')
  assert.equal(s.scrolls, 0)
  s.write('g')
  assert.equal(s.text(), 'def\ng')
  assert.equal(s.scrolls, 1)
})

test('cursor moves and erases land where the escapes say', () => {
  const s = new Screen(3, 5)
  s.write('\x1b[H\x1b[Khello\r\n\x1b[Kworld\x1b[J')
  s.write('\x1b[2;3H\x1b[K!')
  assert.equal(s.text(), 'hello\nwo!\n')
})

test('an escape split across writes is kept until it completes', () => {
  const s = new Screen(1, 10)
  s.write('ab\x1b[3')
  s.write('8;2;1;2;3mcd\x1b[0m')
  assert.equal(s.text(), 'abcd')
})

test('a resize reflows wide rows, so only a full repaint makes the screen whole again', () => {
  const s = new Screen(3, 20)
  s.write('\x1b[H\x1b[Kheader   Online\r\n\x1b[Kbody\r\n\x1b[Ktabs\x1b[J')
  assert.equal(s.text(), s.repainted())
  s.resize(3, 10)
  assert.equal(s.text(), 'header   O\nnline\nbody')
  assert.equal(s.repaintedSinceResize, false)
  s.write('\x1b[3;1H\x1b[Ktabs!')
  assert.notEqual(s.text(), s.repainted())
  s.write('\x1b[H\x1b[Kheader\r\n\x1b[Kbody\r\n\x1b[Ktabs!\x1b[J')
  assert.equal(s.text(), 'header\nbody\ntabs!')
  assert.equal(s.text(), s.repainted())
  assert.equal(s.repaintedSinceResize, true)
})
