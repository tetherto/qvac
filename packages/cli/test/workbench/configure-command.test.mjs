import assert from 'node:assert/strict'
import test from 'node:test'
import { editorCommand } from '../../dist/lib/configure/prompt-adapter.js'

test('editor command preserves quoted arguments and shell metacharacters as literal arguments', () => {
  assert.deepEqual(
    editorCommand('"/Applications/Editor App/editor" --wait "file title" "; literal"', 'darwin'),
    ['/Applications/Editor App/editor', '--wait', 'file title', '; literal']
  )
  assert.deepEqual(editorCommand("editor 'single quoted' $(not-a-shell)", 'linux'), [
    'editor',
    'single quoted',
    '$(not-a-shell)'
  ])
})

test('Windows editor commands preserve drive and UNC path backslashes', () => {
  assert.deepEqual(
    editorCommand(String.raw`"C:\Program Files\Editor\editor.exe" --wait`, 'win32'),
    [String.raw`C:\Program Files\Editor\editor.exe`, '--wait']
  )
  assert.deepEqual(editorCommand(String.raw`"\\server\share\editor.exe"`, 'win32'), [
    String.raw`\\server\share\editor.exe`
  ])
})

test('empty or unclosed editor commands fail clearly', () => {
  assert.throws(() => editorCommand(''), /empty/)
  assert.throws(() => editorCommand('"unfinished'), /Unclosed quote/)
})
