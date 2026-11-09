import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadTemplates,
  loadContextFiles,
  contextPreamble
} from '../../dist/lib/runtime/resources.js'

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-res-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }

  return { root, write, home: path.join(root, 'home'), cwd: path.join(root, 'work', 'app') }
}

test('loadTemplates merges user and project prompts with project winning', (t) => {
  const { write, home, cwd } = fixture(t)
  write('home/.qvac/prompts/review.md', '---\ndescription: user review\n---\nuser')
  write('home/.qvac/prompts/explain.md', 'Explain $1')
  write('home/.qvac/prompts/notes.txt', 'ignored')
  write('work/app/.qvac/prompts/review.md', '---\ndescription: project review\n---\nproject')
  const list = loadTemplates({ cwd, home, fs, path })
  const byName = Object.fromEntries(list.map((x) => [x.name, x]))
  assert.deepEqual(Object.keys(byName).sort(), ['explain', 'review'])
  assert.equal(byName.review.source, 'project')
  assert.equal(byName.review.description, 'project review')
  assert.equal(byName.explain.source, 'user')
  assert.equal(byName.explain.body, 'Explain $1')
})

test('loadTemplates tolerates missing directories', (t) => {
  const { home, cwd } = fixture(t)
  assert.deepEqual(loadTemplates({ cwd, home, fs, path }), [])
})

test('loadContextFiles orders global then root to cwd, preferring AGENTS.md', (t) => {
  const { root, write, home, cwd } = fixture(t)
  write('home/.qvac/AGENTS.md', 'global')
  write('work/CLAUDE.md', 'work claude')
  write('work/app/AGENTS.md', 'app agents')
  write('work/app/CLAUDE.md', 'app claude')
  write('work/app/sub/AGENTS.md', 'below cwd')
  const files = loadContextFiles({ cwd, home, fs, path })
  const ours = files.filter((f) => f.path.startsWith(root))
  assert.deepEqual(
    ours.map((f) => path.relative(root, f.path)),
    [
      path.join('home', '.qvac', 'AGENTS.md'),
      path.join('work', 'CLAUDE.md'),
      path.join('work', 'app', 'AGENTS.md')
    ]
  )
  assert.deepEqual(
    ours.map((f) => f.content),
    ['global', 'work claude', 'app agents']
  )
  assert.equal(files[0].path, path.join(home, '.qvac', 'AGENTS.md'))
})

test('loadContextFiles caps each file at 64KB', (t) => {
  const { write, home, cwd } = fixture(t)
  write('work/app/AGENTS.md', 'x'.repeat(70000))
  const file = loadContextFiles({ cwd, home, fs, path }).at(-1)
  assert.equal(file.content.length, 64 * 1024)
})

test('contextPreamble wraps files in context blocks', () => {
  assert.equal(contextPreamble([]), '')
  const text = contextPreamble([
    { path: '/a/AGENTS.md', content: 'Use tabs\n' },
    { path: '/a/b/CLAUDE.md', content: 'Be brief' }
  ])
  assert.match(text, /project instructions/)
  assert.ok(text.includes('<context file="/a/AGENTS.md">\nUse tabs\n</context>'))
  assert.ok(text.includes('<context file="/a/b/CLAUDE.md">\nBe brief\n</context>'))
  assert.ok(text.indexOf('/a/AGENTS.md') < text.indexOf('/a/b/CLAUDE.md'))
})
