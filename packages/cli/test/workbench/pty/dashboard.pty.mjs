// The real binary in a pseudo-terminal: what a terminal shows of the dashboard after resizes and
// page changes, with no chat anywhere.
import assert from 'node:assert/strict'
import test from 'node:test'
import { sleep, terminal } from '../helpers/pty.mjs'

const ARGS = ['--temp', '--fake-models', '--skip-setup']

async function ready(t, size) {
  const term = terminal(t, ARGS, size)
  await term.waitFor(/Your workspace, at a glance/, 120000)

  return term
}

// Whole: no row left over from an earlier frame, the brand on top, the page tabs and the key
// hints at the bottom, and nothing of a chat.
async function assertWhole(term, label) {
  await term.quiet()
  const { screen } = term
  const rows = screen.text().split('\n')
  assert.ok(screen.repaintedSinceResize, `${label}: no full repaint since the resize`)
  assert.equal(screen.text(), screen.repainted(), `${label}: a row is stale\n${screen.text()}`)
  assert.match(rows[0], /QV\.AC/, `${label}: the brand line is not on top\n${screen.text()}`)
  assert.match(
    rows.at(-2),
    /1 Overview\s+2 Device\s+3 Models/,
    `${label}: the tabs are not at the bottom\n${screen.text()}`
  )
  assert.match(rows.at(-1), /\/ commands/, `${label}: the key hints are not last\n${screen.text()}`)
  assert.doesNotMatch(screen.text(), /Chat|Ask QV\.AC/, `${label}: a chat is shown`)
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

test('every page opens from its key, and the palette from /', async (t) => {
  const term = await ready(t, { rows: 36, cols: 110 })
  for (const [key, pattern] of [
    ['2', /▸ 2 Device/],
    ['3', /▸ 3 Models/],
    ['v', /Together, more capable/],
    ['w', /Choose your workspace/],
    ['s', /This device, right now/],
    ['/', /Commands\s+type to filter/],
    ['\x1b', /This device, right now/],
    ['1', /▸ 1 Overview/]
  ]) {
    term.keys(key)
    await term.waitFor(pattern)
    await sleep(300)
    await assertWhole(term, `after ${JSON.stringify(key)}`)
  }
})
