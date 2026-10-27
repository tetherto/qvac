import test from 'node:test'
import assert from 'node:assert/strict'
import { Editor } from '../../dist/product/editor.js'
import { cellWidth } from '../../dist/product/text.js'

const { KeyMsg } = await import(new URL('./messages.js', import.meta.resolve('bare-tui')))

function chord(text) {
  const parts = text.split('+')
  const name = parts.pop() || '+'
  const mods = {
    ctrl: parts.includes('ctrl'),
    meta: parts.includes('alt'),
    shift: parts.includes('shift')
  }
  const sequence = !mods.ctrl && !mods.meta && name.length === 1 ? name : ''

  return new KeyMsg({ name, sequence, ...mods })
}
const press = (editor, ...keys) =>
  keys.map((key) => editor.key(typeof key === 'string' ? chord(key) : new KeyMsg(key)))
const type = (editor, text) => {
  for (const char of text) {
    editor.key(new KeyMsg({ name: char, sequence: char }))
  }
}
const at = (value, cursor) => {
  const editor = new Editor()
  editor.set(value)
  editor.cursor = cursor ?? value.length
  return editor
}
const shown = (editor) =>
  editor.value.slice(0, editor.cursor) + '|' + editor.value.slice(editor.cursor)

test('character movement steps whole code points', () => {
  const editor = at('a🌍b', 0)
  press(editor, 'right', 'ctrl+f')
  assert.equal(shown(editor), 'a🌍|b')
  press(editor, 'left')
  assert.equal(shown(editor), 'a|🌍b')
  press(editor, 'ctrl+b', 'ctrl+b')
  assert.equal(shown(editor), '|a🌍b')
  press(editor, 'end')
  assert.equal(shown(editor), 'a🌍b|')
})

test('word movement with alt, ctrl and readline chords', () => {
  const editor = at('foo bar_1  baz.qux')
  press(editor, 'alt+left')
  assert.equal(shown(editor), 'foo bar_1  baz.|qux')
  press(editor, 'ctrl+left', 'alt+b')
  assert.equal(shown(editor), 'foo |bar_1  baz.qux')
  press(editor, 'alt+right')
  assert.equal(shown(editor), 'foo bar_1|  baz.qux')
  press(editor, 'ctrl+right')
  assert.equal(shown(editor), 'foo bar_1  baz|.qux')
  press(editor, 'alt+f')
  assert.equal(shown(editor), 'foo bar_1  baz.qux|')
})

test('home and end are line-relative in multi-line text', () => {
  const editor = at('one\ntwo three\nfour', 8)
  press(editor, 'home')
  assert.equal(editor.cursor, 4)
  press(editor, 'ctrl+e')
  assert.equal(editor.cursor, 13)
  press(editor, 'ctrl+a', 'home')
  assert.equal(editor.cursor, 4)
  press(editor, 'end')
  assert.equal(editor.cursor, 13)
})

test('up and down move within lines and report the edges', () => {
  const editor = at('abcdef\nxy\nlonger', 5)
  assert.deepEqual(press(editor, 'up'), [false])
  assert.deepEqual(press(editor, 'down'), [true])
  assert.equal(editor.cursor, 9)
  press(editor, 'down')
  assert.equal(editor.cursor, 12)
  assert.deepEqual(press(editor, 'down'), [false])
  press(editor, 'up', 'up')
  assert.equal(editor.cursor, 2)
})

test('ctrl+] waits for a character and jumps forward to it', () => {
  const editor = at('a,b,c', 0)
  assert.deepEqual(press(editor, 'ctrl+]'), [true])
  type(editor, ',')
  assert.equal(editor.cursor, 1)
  assert.equal(editor.value, 'a,b,c')
  editor.key(new KeyMsg({ name: '\x1d', sequence: '\x1d' }))
  type(editor, ',')
  assert.equal(editor.cursor, 3)
  press(editor, 'ctrl+]')
  type(editor, 'z')
  assert.equal(editor.cursor, 3)
  press(editor, 'ctrl+]', 'left')
  assert.equal(editor.cursor, 2)
  type(editor, 'x')
  assert.equal(editor.value, 'a,xb,c')
})

test('character deletion forwards and backwards', () => {
  const editor = at('ab🌍cd', 4)
  press(editor, 'backspace')
  assert.equal(shown(editor), 'ab|cd')
  press(editor, 'delete')
  assert.equal(shown(editor), 'ab|d')
  press(editor, 'ctrl+d')
  assert.equal(shown(editor), 'ab|')
  assert.deepEqual(press(editor, 'ctrl+d'), [true])
  assert.equal(editor.value, 'ab')
})

test('word and line kills', () => {
  const editor = at('alpha beta gamma', 11)
  press(editor, 'ctrl+w')
  assert.equal(shown(editor), 'alpha |gamma')
  press(editor, 'alt+backspace')
  assert.equal(shown(editor), '|gamma')
  press(editor, 'alt+d')
  assert.equal(shown(editor), '|')

  const other = at('keep this\nline two\nend', 13)
  press(other, 'ctrl+u')
  assert.equal(shown(other), 'keep this\n|e two\nend')
  press(other, 'ctrl+k')
  assert.equal(shown(other), 'keep this\n|\nend')
  press(other, 'ctrl+k')
  assert.equal(shown(other), 'keep this\n|end')
  press(other, 'ctrl+u')
  assert.equal(shown(other), 'keep this|end')
  const forward = at('one two', 0)
  forward.key(new KeyMsg({ name: 'delete', sequence: '', meta: true }))
  assert.equal(shown(forward), '| two')
})

test('kill ring appends consecutive kills and yanks with rotation', () => {
  const editor = at('one two three', 13)
  press(editor, 'ctrl+w', 'ctrl+w')
  assert.equal(editor.value, 'one ')
  assert.deepEqual(editor.killRing, ['two three'])
  press(editor, 'ctrl+y')
  assert.equal(editor.value, 'one two three')
  press(editor, 'home', 'alt+d', 'right', 'alt+d')
  assert.deepEqual(editor.killRing, ['two three', 'one', 'two'])
  press(editor, 'end', 'ctrl+y')
  assert.equal(shown(editor), '  threetwo|')
  press(editor, 'alt+y')
  assert.equal(shown(editor), '  threeone|')
  press(editor, 'alt+y')
  assert.equal(shown(editor), '  threetwo three|')
  press(editor, 'alt+y')
  assert.equal(shown(editor), '  threetwo|')
  press(editor, 'left')
  assert.deepEqual(press(editor, 'alt+y'), [false])
  assert.equal(editor.value, '  threetwo')
})

test('kills in alternating directions start new ring entries', () => {
  const editor = at('ab cd ef', 5)
  press(editor, 'ctrl+w', 'alt+d')
  assert.deepEqual(editor.killRing, ['cd', ' ef'])
  press(editor, 'ctrl+k')
  assert.equal(editor.killRing.length, 2)
})

test('undo restores previous states and coalesces typing', () => {
  const editor = new Editor()
  type(editor, 'hello')
  press(editor, 'space')
  editor.key(new KeyMsg({ name: 'space', sequence: ' ' }))
  type(editor, 'world')
  press(editor, 'left')
  type(editor, '!')
  assert.equal(editor.value, 'hello worl!d')
  press(editor, 'ctrl+-')
  assert.equal(editor.value, 'hello world')
  press(editor, 'ctrl+w')
  assert.equal(editor.value, 'hello d')
  press(editor, 'ctrl+_')
  assert.equal(editor.value, 'hello world')
  editor.key(new KeyMsg({ name: '\x1f', sequence: '\x1f' }))
  assert.equal(editor.value, 'hello')
  press(editor, 'ctrl+z')
  assert.equal(editor.value, '')
  type(editor, 'x')
  assert.equal(editor.value, 'x')
  editor.key(new KeyMsg({ name: 'undo', sequence: '' }))
  assert.equal(editor.value, '')
})

test('undo history is capped at 200 steps', () => {
  const editor = new Editor()
  for (let i = 0; i < 250; i++) {
    editor.insert('x')
  }

  let steps = 0
  while (editor.undo()) {
    steps++
  }

  assert.equal(steps, 200)
  assert.equal(editor.value, 'x'.repeat(50))
})

test('large pastes become atomic markers that expand on submit', () => {
  const editor = new Editor()
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
  editor.insert('see ')
  editor.paste(lines)
  assert.equal(editor.value, 'see [paste #1 +12 lines]')
  editor.paste('y'.repeat(1500))
  assert.equal(editor.value, 'see [paste #1 +12 lines][paste #2 1500 chars]')
  editor.paste('small\npaste')
  assert.equal(editor.expanded(), 'see ' + lines + 'y'.repeat(1500) + 'small\npaste')
  editor.cursor = 0
  press(editor, 'alt+f', 'alt+f')
  assert.equal(editor.value.slice(editor.cursor), '\npaste')
  editor.cursor = 4
  press(editor, 'right')
  assert.equal(editor.cursor, 24)
  press(editor, 'backspace')
  assert.equal(editor.value, 'see [paste #2 1500 chars]small\npaste')
  press(editor, 'delete')
  assert.equal(editor.value, 'see small\npaste')
  press(editor, 'ctrl+z', 'ctrl+z')
  assert.equal(editor.value, 'see [paste #1 +12 lines][paste #2 1500 chars]small\npaste')
  editor.remember()
  assert.equal(editor.history.at(-1), 'see ' + lines + 'y'.repeat(1500) + 'small\npaste')
  assert.equal(editor.pastes.size, 0)
  editor.paste(lines)
  assert.equal(editor.value, '[paste #1 +12 lines]')
})

test('typed marker look-alikes stay plain text', () => {
  const editor = new Editor()
  editor.insert('[paste #9 +20 lines]')
  press(editor, 'backspace')
  assert.equal(editor.value, '[paste #9 +20 lines')
  assert.equal(editor.expanded(), editor.value)
})

test('rows stay within width for wide characters and emoji', () => {
  const editor = new Editor()
  editor.insert('世界🌍👩‍💻 abc '.repeat(12) + '\n' + '宽'.repeat(30))
  for (const width of [1, 2, 3, 7, 20]) {
    const rows = editor.rows(width, 50)
    assert.ok(rows.length > 0)
    for (const row of rows) {
      assert.equal(cellWidth(row), width)
    }
  }

  assert.ok(editor.rows(5, 3).at(-1).includes('▏'))
  editor.cursor = 0
  assert.ok(editor.rows(5, 3)[0].startsWith('▏'))
})

test('history and limits keep working', () => {
  const editor = new Editor()
  editor.limit = 5
  type(editor, 'abcdefg')
  assert.equal(editor.value, 'abcde')
  editor.remember()
  editor.insert('draft')
  editor.recall(-1)
  assert.equal(editor.value, 'abcde')
  editor.recall(1)
  assert.equal(editor.value, 'draft')
  assert.deepEqual(press(editor, 'ctrl+c'), [false])
})
