// The real binary in a pseudo-terminal: what a terminal shows after resizes, runs and page changes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sleep, terminal } from '../helpers/pty.mjs'

const ARGS = ['--temp', '--fake-models', '--skip-setup']

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-pty-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'README.md'), '# scratch\n')

  return dir
}

async function ready(t, size) {
  const term = terminal(t, ARGS, { cwd: project(t), ...size })
  await term.waitFor(/Ask QV\.AC anything/, 120000)

  return term
}

// Whole: no row left over from an earlier frame, the brand on top, the page tabs at the bottom.
async function assertWhole(term, label) {
  await term.quiet()
  const { screen } = term
  const rows = screen.text().split('\n')
  assert.ok(screen.repaintedSinceResize, `${label}: no full repaint since the resize`)
  assert.equal(screen.text(), screen.repainted(), `${label}: a row is stale\n${screen.text()}`)
  assert.match(rows[0], /QV\.AC/, `${label}: the brand line is not on top\n${screen.text()}`)
  assert.match(
    rows.at(-1),
    /Chat\s+1 Overview/,
    `${label}: the tabs are not at the bottom\n${screen.text()}`
  )
  assert.ok((screen.text().match(/Online/g) || []).length <= 1, `${label}: status shown twice`)
}

test('the screen stays whole through resizes in every direction', async (t) => {
  const term = await ready(t, { rows: 40, cols: 120 })
  await assertWhole(term, 'boot')
  for (const [rows, cols] of [
    [24, 120],
    [24, 80],
    [50, 80],
    [50, 160],
    [16, 60],
    [40, 120]
  ]) {
    term.resize(rows, cols)
    await sleep(400)
    await assertWhole(term, `${rows}x${cols}`)
  }
})

test('a resize in the middle of an answer keeps the footer', async (t) => {
  const term = await ready(t, { rows: 36, cols: 110 })
  term.keys('write a long answer about terminals\r')
  await term.waitFor(/quack/)
  term.resize(22, 90)
  await sleep(300)
  term.resize(44, 130)
  await term.waitFor(/Ready/)
  await sleep(300)
  await assertWhole(term, 'after the answer')
})

test('a burst of resizes, like dragging a window edge, settles whole', async (t) => {
  const term = await ready(t, { rows: 40, cols: 120 })
  for (let i = 0; i < 30; i++) {
    term.resize(40 - (i % 15), 120 - i)
    await sleep(15)
  }

  await sleep(500)
  await assertWhole(term, 'after the drag')
})

test('switching pages mid-answer neither stops the run nor leaves rows behind', async (t) => {
  const term = await ready(t, { rows: 36, cols: 110 })
  term.keys('write a long answer about terminals\r')
  await term.waitFor(/quack/)
  term.keys('\x1b1')
  await term.waitFor(/▸ 1 Overview/)
  await sleep(300)
  term.keys('c')
  await term.waitFor(/▸ Chat/)
  await term.waitFor(/● Ready/)
  await sleep(300)
  await assertWhole(term, 'back in chat')
  assert.doesNotMatch(term.screen.text(), /Stopped/)
})
