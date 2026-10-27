import test from 'node:test'
import assert from 'node:assert/strict'
import {
  diffLines,
  hunks,
  renderDiff,
  diffStat,
  toolSummary,
  renderToolBody,
  renderApprovalPreview
} from '../../dist/product/tool-view.js'
import { plain } from '../../dist/product/theme.js'
import { cellWidth } from '../../dist/product/text.js'

const ops = (a, b) => diffLines(a, b).map((l) => l.op + l.text)
const fits = (rows, width) =>
  rows.forEach((r) =>
    assert.ok(
      cellWidth(plain(r)) <= width,
      `row too wide (${cellWidth(plain(r))} > ${width}): ${plain(r)}`
    )
  )
const shown = (r) => plain(r).trimEnd()
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

// Applying the diff must reproduce both sides.
function check(a, b) {
  const d = diffLines(a, b)
  const split = (s) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))
  assert.deepEqual(
    d.filter((l) => l.op !== '+').map((l) => l.text),
    split(a)
  )
  assert.deepEqual(
    d.filter((l) => l.op !== '-').map((l) => l.text),
    split(b)
  )

  return d
}

test('diffLines: identical, empty, insert, delete, replace', () => {
  assert.deepEqual(ops('a\nb', 'a\nb'), [' a', ' b'])
  assert.deepEqual(diffLines('', ''), [])
  assert.deepEqual(ops('', 'x\ny'), ['+x', '+y'])
  assert.deepEqual(ops('x\ny', ''), ['-x', '-y'])
  assert.deepEqual(ops('a\nc', 'a\nb\nc'), [' a', '+b', ' c'])
  assert.deepEqual(ops('a\nb\nc', 'a\nc'), [' a', '-b', ' c'])
  assert.deepEqual(ops('a\nb\nc', 'a\nB\nc'), [' a', '-b', '+B', ' c'])
  assert.deepEqual(ops('a\n', 'a'), [' a'])
})

test('diffLines: line numbers', () => {
  const d = diffLines('a\nb\nc', 'a\nX\nc\nd')
  assert.deepEqual(
    d.map((l) => [l.op, l.oldNo, l.newNo]),
    [
      [' ', 1, 1],
      ['-', 2, null],
      ['+', null, 2],
      [' ', 3, 3],
      ['+', null, 4]
    ]
  )
})

test('diffLines: minimal edits on interleaved changes', () => {
  const a = 'a\nb\nc\nd\ne\nf\ng',
    b = 'a\nc\nd\nX\ne\ng\nh'
  const d = check(a, b)
  assert.equal(d.filter((l) => l.op !== ' ').length, 4)
  check('x\na\nb\nx\nc', 'a\nx\nb\nc\nx')
})

test('diffLines: large inputs are fast and fall back on huge products', () => {
  const a = lines(5000)
  const b = a.replace('line 2500\n', 'line 2500 changed\n').replace('line 10\n', '')
  const t = Date.now()
  const d = check(a, b)
  assert.equal(d.filter((l) => l.op !== ' ').length, 3)
  const x = Array.from({ length: 3000 }, (_, i) => 'a' + i).join('\n')
  const y = Array.from({ length: 3000 }, (_, i) => 'b' + i).join('\n')
  const big = check('head\n' + x + '\ntail', 'head\n' + y + '\ntail')
  assert.equal(big.filter((l) => l.op === '-').length, 3000)
  assert.equal(big[0].op, ' ')
  assert.equal(big[big.length - 1].op, ' ')
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t}ms`)
})

test('diffStat', () => {
  assert.deepEqual(diffStat('a\nb\nc', 'a\nB\nc\nd'), { added: 2, removed: 1 })
  assert.deepEqual(diffStat('same', 'same'), { added: 0, removed: 0 })
  assert.deepEqual(diffStat('', 'x\ny\nz'), { added: 3, removed: 0 })
})

test('hunks: headers and grouping', () => {
  const a = lines(20)
  const b = a.replace('line 2\n', 'line two\n').replace('line 18\n', '')
  const hs = hunks(diffLines(a, b))
  assert.deepEqual(
    hs.map((h) => h.header),
    ['@@ -1,5 +1,5 @@', '@@ -15,6 +15,5 @@']
  )
  assert.equal(hunks(diffLines(a, b), 10).length, 1)
  assert.deepEqual(hunks(diffLines(a, a)), [])
  assert.deepEqual(
    hunks(diffLines('', 'x\ny')).map((h) => h.header),
    ['@@ -0,0 +1,2 @@']
  )
  assert.deepEqual(
    hunks(diffLines('x\ny', '')).map((h) => h.header),
    ['@@ -1,2 +0,0 @@']
  )
})

test('renderDiff: colours, gutter, separators and cut-off', () => {
  const a = lines(40)
  const b = a.replace('line 3\n', 'line three\n').replace('line 30\n', 'line thirty\n')
  const rows = renderDiff(a, b, { width: 80 })
  const text = rows.map(shown)
  assert.ok(text.includes(' 3 − line 3'))
  assert.ok(text.includes(' 3 + line three'))
  assert.ok(text.includes(' 1   line 1'))
  assert.ok(text.some((r) => r.trim() === '⋯'))
  const removed = rows.find((r) => plain(r).includes('− line 3'))
  const added = rows.find((r) => plain(r).includes('+ line three'))
  assert.ok(removed.includes('255;174;155') && removed.includes('48;2;64;32;38'))
  assert.ok(added.includes('131;231;172') && added.includes('48;2;18;52;46'))
  assert.equal(
    rows.find((r) => plain(r) === ' 1   line 1').includes('48;2;'),
    false,
    'context is not tinted'
  )
  assert.ok(rows.find((r) => plain(r).trim() === '⋯').includes('53;74;86'))
  const short = renderDiff(a, b, { width: 80, maxLines: 5 }).map(plain)
  assert.equal(short.length, 6)
  assert.match(short[5], /^… \d+ more lines$/)
  assert.deepEqual(renderDiff('x', 'x', { width: 80 }), [])
})

test('renderDiff: startLine offsets numbers', () => {
  const text = renderDiff('a\nb', 'a\nc', { width: 80, startLine: 100 }).map(shown)
  assert.deepEqual(text, ['100   a', '101 − b', '101 + c'])
})

test('renderDiff: respects width at 30 and 80 columns', () => {
  const long =
    'x'.repeat(200) + ' 漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字'
  for (const width of [30, 80]) {
    const rows = renderDiff('short\n\tindent\n' + long, 'short\n' + long + '!\nadded', {
      width: width,
      maxLines: 3
    })
    fits(rows, width)
    assert.ok(rows.map(plain).some((r) => r.endsWith('…')))
  }
})

test('toolSummary: edit and write', () => {
  assert.deepEqual(
    toolSummary({
      name: 'edit_file',
      args: { path: 'src/app.mjs', old: 'a\nb', new: 'a\nB\nC\nD' },
      result: { edited: 'src/app.mjs', replacements: 1 }
    }),
    { title: 'Edit src/app.mjs', detail: '+3 −1', failed: false }
  )
  assert.equal(
    toolSummary({
      name: 'edit_file',
      args: { path: 'x', old: 'a', new: 'b', replaceAll: true },
      result: { replacements: 4 }
    }).detail,
    '+1 −1 · 4 replacements'
  )
  const content = lines(42)
  assert.deepEqual(
    toolSummary({
      name: 'write_file',
      args: { path: 'README.md', content },
      result: { written: 'README.md', replaced: false }
    }),
    { title: 'Write README.md', detail: 'new file · 42 lines', failed: false }
  )
  assert.equal(
    toolSummary({
      name: 'write_file',
      args: { path: 'README.md', content },
      result: { replaced: true }
    }).detail,
    'overwrote · 42 lines'
  )
  assert.equal(
    toolSummary(
      {
        name: 'write_file',
        args: { path: 'README.md', content: 'a\nb\nc' },
        result: { replaced: true }
      },
      { before: 'a\nx' }
    ).detail,
    '+2 −1'
  )
})

test('toolSummary: read, list, grep, glob', () => {
  assert.deepEqual(
    toolSummary({
      name: 'read_file',
      args: { path: 'src/app.mjs' },
      result: { content: 'lines 1-40 of 120\n1| hi' }
    }),
    { title: 'Read src/app.mjs', detail: 'lines 1-40 of 120', failed: false }
  )
  assert.equal(
    toolSummary({ name: 'read_file', args: { path: 'a', startLine: 5, endLine: 9 } }).detail,
    'lines 5-9'
  )
  assert.deepEqual(
    toolSummary({ name: 'list_dir', args: { path: 'src/' }, result: { entries: 'a.mjs\nb.mjs' } }),
    {
      title: 'List src/',
      detail: '2 entries',
      failed: false
    }
  )
  assert.equal(
    toolSummary({ name: 'list_dir', args: {}, result: { entries: 'a', truncated: true } }).title,
    'List .'
  )
  const many = Array.from({ length: 12 }, (_, i) => `f.mjs:${i}: foo`).join('\n')
  assert.deepEqual(
    toolSummary({ name: 'grep', args: { pattern: 'foo' }, result: { matches: many } }),
    {
      title: 'Search "foo"',
      detail: '12 matches',
      failed: false
    }
  )
  assert.equal(
    toolSummary({ name: 'grep', args: { pattern: 'foo' }, result: { matches: 'no matches' } })
      .detail,
    'no matches'
  )
  assert.equal(
    toolSummary({
      name: 'grep',
      args: { pattern: 'foo' },
      result: { matches: many, truncated: true }
    }).detail,
    '12 matches+'
  )
  assert.deepEqual(
    toolSummary({
      name: 'grep',
      args: { pattern: 'a|b', regex: true, dir: 'src', include: '*.mjs', output: 'files' },
      result: { matches: 'src/a.mjs\nsrc/b.mjs' }
    }),
    { title: 'Search /a|b/ in src *.mjs', detail: '2 files', failed: false }
  )
  assert.equal(
    toolSummary({
      name: 'grep',
      args: { pattern: 'new .*App' },
      result: { matches: 'no matches (the pattern was searched as plain text; set regex: true)' }
    }).detail,
    'no matches (the pattern was searched as plain text; set regex: true)'
  )
  assert.equal(
    toolSummary({
      name: 'grep',
      args: { pattern: 'stalled' },
      result: {
        matches:
          '110 matches in 2 files, too many lines to show; the files (first line, count) follow.\na.ts:1 (80)\nb.ts:1 (30)'
      }
    }).detail,
    '110 matches in 2 files · narrow it'
  )
  const files = Array.from({ length: 30 }, (_, i) => `f${i}.mjs`)
  assert.deepEqual(
    toolSummary({ name: 'glob', args: { pattern: '**/*.mjs' }, result: { matches: files } }),
    {
      title: 'Find **/*.mjs',
      detail: '30 files',
      failed: false
    }
  )
})

test('toolSummary: exec, shell and file ops', () => {
  assert.deepEqual(
    toolSummary({
      name: 'exec',
      args: { command: 'npm test' },
      result: { stdout: '', stderr: '', exitCode: 0 }
    }),
    { title: 'Run npm test', detail: 'exit 0', failed: false }
  )
  assert.deepEqual(
    toolSummary({
      name: 'exec',
      args: { command: 'npm test' },
      result: { stdout: '', stderr: 'boom', exitCode: 1 }
    }),
    { title: 'Run npm test', detail: 'exit 1', failed: true }
  )
  assert.equal(
    toolSummary({
      name: 'exec',
      args: { language: 'python', script: 'print(1)' },
      result: { exitCode: 0 }
    }).title,
    'Run python script'
  )
  assert.deepEqual(
    toolSummary({
      name: 'shell',
      args: { command: 'npm run dev', background: true },
      result: { job: 3, status: 'running', note: 'started' }
    }),
    { title: 'Run npm run dev', detail: 'background · running', failed: false }
  )
  assert.equal(
    toolSummary({ name: 'shell', args: { command: 'false' }, result: { exitCode: 2 } }).failed,
    true
  )
  assert.equal(
    toolSummary({
      name: 'move_file',
      args: { from: 'a', to: 'b' },
      result: { moved: 'a', to: 'b' }
    }).title,
    'Move a → b'
  )
  assert.equal(
    toolSummary({
      name: 'copy_file',
      args: { from: 'a', to: 'b' },
      result: { copied: 'a', to: 'b' }
    }).title,
    'Copy a → b'
  )
  assert.equal(
    toolSummary({ name: 'make_dir', args: { path: 'd' }, result: { created: 'd' } }).title,
    'Create d'
  )
  assert.deepEqual(
    toolSummary({
      name: 'trash_file',
      args: { path: 'x' },
      result: { trashed: 'x', restorableAt: 'y' }
    }),
    {
      title: 'Trash x',
      detail: 'restorable',
      failed: false
    }
  )
  assert.deepEqual(toolSummary({ name: 'web_search', args: { query: 'qvac', n: 3 }, result: {} }), {
    title: 'web_search',
    detail: 'qvac',
    failed: false
  })
  assert.equal(toolSummary({ name: 'exec', args: { command: 'ls' } }).failed, false)
})

test('toolSummary: errors and denials', () => {
  assert.deepEqual(
    toolSummary({
      name: 'edit_file',
      args: { path: 'a', old: 'x', new: 'y' },
      result: { error: 'old text not found\nmore' }
    }),
    { title: 'Edit a', detail: 'old text not found', failed: true }
  )
  assert.deepEqual(
    toolSummary({
      name: 'shell',
      args: { command: 'rm -rf /' },
      result: { error: 'denied by user', denied: true }
    }),
    { title: 'Run rm -rf /', detail: 'denied', failed: true }
  )
})

test('renderToolBody: edit diff collapses unless expanded', () => {
  const old = lines(30),
    next = lines(30).replace(/line/g, 'LINE')
  const rows = renderToolBody(
    { name: 'edit_file', args: { path: 'a', old, new: next }, result: { replacements: 1 } },
    { width: 80 }
  )
  assert.equal(rows.length, 13)
  assert.match(plain(rows[12]), /^… 48 more lines$/)
  assert.equal(
    renderToolBody(
      { name: 'edit_file', args: { path: 'a', old, new: next }, result: {} },
      { width: 80, expand: true }
    ).length,
    60
  )
})

test('renderToolBody: write without and with before', () => {
  const content = lines(20)
  const fresh = renderToolBody(
    { name: 'write_file', args: { path: 'a', content }, result: { replaced: false } },
    { width: 80 }
  ).map(shown)
  assert.equal(fresh.length, 9)
  assert.equal(fresh[0], ' 1 + line 1')
  assert.equal(fresh[8], '… 12 more lines')
  const before = content.replace('line 10\n', 'old ten\n')
  const diff = renderToolBody(
    { name: 'write_file', args: { path: 'a', content }, result: { replaced: true } },
    { width: 80, before }
  ).map(shown)
  assert.ok(diff.includes('10 − old ten'))
  assert.ok(diff.includes('10 + line 10'))
  assert.ok(diff.every((r) => !r.includes('line 1 ') && r !== ' 1   line 1'))
})

test('an overwrite with no earlier text shows the file, not a diff against nothing', () => {
  const rows = renderToolBody(
    {
      name: 'write_file',
      args: { path: '.gitignore', content: 'node_modules/\n# built\ndist/' },
      result: { replaced: true }
    },
    { width: 80 }
  ).map(shown)
  assert.deepEqual(rows, ['1   node_modules/', '2   # built', '3   dist/'])
})

test('renderToolBody: exec output, truncation marker and tail', () => {
  const stdout = 'start\n…[5000 chars omitted]…\n' + lines(10)
  const rows = renderToolBody(
    { name: 'exec', args: { command: 'x' }, result: { stdout, stderr: 'warn: bad', exitCode: 1 } },
    { width: 80 }
  )
  const text = rows.map(plain)
  assert.equal(rows.length, 7)
  assert.match(text[0], /^… \d+ earlier lines$/)
  assert.equal(text[6], 'warn: bad')
  assert.ok(rows[6].includes('255;174;155'))
  const all = renderToolBody(
    { name: 'exec', args: { command: 'x' }, result: { stdout, stderr: '', exitCode: 0 } },
    { width: 80, expand: true }
  )
  const marker = all.find((r) => plain(r).includes('chars omitted'))
  assert.equal(plain(marker), '… 5000 chars omitted')
  assert.ok(marker.includes('43;216;189'))
  assert.equal(all.length, 12)
  const hinted = renderToolBody(
    {
      name: 'shell',
      args: { command: 'x' },
      result: {
        stdout: 'a\n…[12 chars omitted; read_file path=/tmp/o startLine=40]…\nb',
        exitCode: 0
      }
    },
    { width: 80 }
  ).map(plain)
  assert.deepEqual(hinted, ['a', '… 12 chars omitted', 'b'])
  fits(
    renderToolBody(
      { name: 'exec', args: { command: 'x' }, result: { stdout: 'y'.repeat(500), exitCode: 0 } },
      { width: 30 }
    ),
    30
  )
})

test('renderToolBody: listing tools only when expanded; errors in red', () => {
  const result = { content: 'lines 1-3 of 3\n1| a\n2| b\n3| c' }
  assert.deepEqual(
    renderToolBody({ name: 'read_file', args: { path: 'a' }, result: result }, { width: 80 }),
    []
  )
  assert.deepEqual(
    renderToolBody(
      { name: 'read_file', args: { path: 'a' }, result: result },
      { width: 80, expand: true }
    ).map(plain),
    ['1| a', '2| b', '3| c']
  )
  const many = renderToolBody(
    {
      name: 'glob',
      args: { pattern: '*' },
      result: { matches: Array.from({ length: 25 }, (_, i) => 'f' + i) }
    },
    { width: 80, expand: true }
  ).map(plain)
  assert.equal(many.length, 21)
  assert.equal(many[20], '… 5 more lines')
  const error = Array.from({ length: 6 }, (_, i) => 'problem ' + i).join('\n')
  const rows = renderToolBody(
    { name: 'edit_file', args: { old: 'a', new: 'b' }, result: { error } },
    { width: 80 }
  )
  assert.equal(rows.length, 3)
  assert.ok(rows[0].includes('255;174;155'))
  assert.equal(
    renderToolBody({ name: 'edit_file', args: {}, result: { error } }, { width: 80, expand: true })
      .length,
    6
  )
})

test('renderApprovalPreview', () => {
  assert.deepEqual(
    renderApprovalPreview(
      { name: 'edit_file', args: { path: 'a', old: 'x', new: 'y' } },
      { width: 80 }
    ).map(shown),
    ['1 − x', '1 + y']
  )
  assert.deepEqual(
    renderApprovalPreview(
      { name: 'write_file', args: { path: 'a', content: 'n' } },
      { width: 80, before: 'o' }
    ).map(shown),
    ['1 − o', '1 + n']
  )
  const cmd = renderApprovalPreview(
    { name: 'shell', args: { command: 'npm test', cwd: 'pkg' } },
    { width: 80 }
  )
  assert.deepEqual(cmd.map(plain), ['$ npm test', 'in pkg'])
  assert.ok(cmd[0].includes('212;223;230'))
  assert.deepEqual(
    renderApprovalPreview({ name: 'move_file', args: { from: 'a', to: 'b' } }, { width: 80 }).map(
      plain
    ),
    ['a → b']
  )
  assert.deepEqual(
    renderApprovalPreview({ name: 'trash_file', args: { path: 'x' } }, { width: 80 }).map(plain),
    ['x']
  )
  fits(
    renderApprovalPreview(
      { name: 'exec', args: { command: 'z'.repeat(100), script: 'q'.repeat(100) } },
      { width: 30 }
    ),
    30
  )
})

test('delegate lists its tasks while running and each answer once it returns', () => {
  const args = { tasks: ['Review src/a.mjs for bugs', 'Review src/b.mjs for bugs'] }
  assert.deepEqual(toolSummary({ name: 'delegate', args }), {
    title: 'Delegate 2 tasks',
    detail: '2 running',
    failed: false
  })
  const running = renderToolBody({ name: 'delegate', args }, { width: 60 }).map(plain)
  assert.deepEqual(running, ['◌ Review src/a.mjs for bugs', '◌ Review src/b.mjs for bugs'])

  const result = {
    results: [
      { task: args.tasks[0], status: 'answered', text: 'No bugs.\nThe loop is fine.\nDone.' },
      { task: args.tasks[1], status: 'error', text: 'model unavailable' }
    ]
  }
  assert.equal(
    toolSummary({ name: 'delegate', args, result }).detail,
    '1 answered · 1 not answered'
  )
  const done = renderToolBody({ name: 'delegate', args, result }, { width: 60 }).map(plain)
  assert.deepEqual(done, [
    '✓ Review src/a.mjs for bugs',
    '  No bugs.',
    '  The loop is fine.',
    '✗ Review src/b.mjs for bugs',
    '  model unavailable'
  ])
  const external = { tasks: [{ task: 'Write the migration', target: 'codex' }] }
  assert.match(
    plain(renderToolBody({ name: 'delegate', args: external }, { width: 60 })[0]),
    /codex · Write/
  )
  for (const row of renderToolBody(
    { name: 'delegate', args, result },
    { width: 24, expand: true }
  )) {
    assert.ok([...plain(row)].length <= 24, row)
  }
})
