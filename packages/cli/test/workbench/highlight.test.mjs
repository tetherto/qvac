import assert from 'node:assert/strict'
import test from 'node:test'
import { languageOf, paintCode } from '../../dist/product/highlight.js'
import { palette, plain } from '../../dist/product/theme.js'

const colorOf = (painted, token) => {
  const at = painted.indexOf(token)
  const codes = [...painted.slice(0, at).matchAll(/\x1b\[38;2;([\d;]+)m/g)]
  return Object.keys(palette).find((k) => palette[k] === codes.at(-1)[1])
}

test('languageOf reads fence tags, extensions and dotfiles', () => {
  assert.equal(languageOf('ts'), 'js')
  assert.equal(languageOf('src/app.mjs'), 'js')
  assert.equal(languageOf('scripts/run.py'), 'py')
  assert.equal(languageOf('.gitignore'), 'conf')
  assert.equal(languageOf('README'), null)
  assert.equal(languageOf(undefined), null)
})

test('paintCode colours keywords, strings, numbers, calls and comments', () => {
  const line = "const total = sum('a // b', 42) // add up"
  const painted = paintCode(line, 'js')

  assert.equal(plain(painted), line)
  assert.equal(colorOf(painted, 'const'), 'purple')
  assert.equal(colorOf(painted, "'a // b'"), 'green')
  assert.equal(colorOf(painted, '42'), 'red')
  assert.equal(colorOf(painted, 'sum'), 'teal')
  assert.equal(colorOf(painted, '// add up'), 'muted')
  assert.equal(painted.includes('\x1b[0m'), false, 'no reset, so a tinted row keeps its background')
})

test('a # starts a comment only at the line start or after a space', () => {
  const painted = paintCode('echo "#1" a#b # note', 'sh')
  const comment = painted.split(`\x1b[38;2;${palette.muted}m`)
  assert.equal(comment.length, 2)
  assert.equal(plain(comment[1]), '# note')
})

test('an unknown language is plain text', () => {
  assert.equal(plain(paintCode('const x = 1', null)), 'const x = 1')
  assert.equal(colorOf(paintCode('const x = 1', null), 'const'), 'text')
})
