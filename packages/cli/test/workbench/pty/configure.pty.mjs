import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { terminal, sleep } from '../helpers/pty.mjs'
import { Screen } from '../helpers/vt.mjs'

const bridge = new URL('../helpers/pty-bridge.py', import.meta.url).pathname
const fixture = new URL('../fixtures/configure-prompts.mjs', import.meta.url).pathname
function prompt(t, mode, env = {}, rows = 28, cols = 100) {
  const child = spawn('python3', [bridge, rows, cols, process.execPath, fixture, mode], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    detached: true
  })
  let output = ''
  const screen = new Screen(rows, cols)
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk
    screen.write(chunk)
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    output += chunk
  })
  const closed = once(child, 'close')
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  })
  return {
    child,
    closed,
    screen,
    output: () => output,
    keys: (text) => child.stdin.write(text),
    async wait(pattern) {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if (pattern.test(output)) return
        await sleep(20)
      }
      throw new Error(`Waiting for ${pattern}: ${output}`)
    }
  }
}
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-editor-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('configure prompts preserve pagination, search descriptions, editing, validation and confirmation', async (t) => {
  const term = prompt(t, 'flow')
  await term.wait(/CHOOSE/)
  term.keys('\x1b[B\x1b[B\x1b[B')
  await term.wait(/Preview 3/)
  term.keys('\r')
  await term.wait(/SEARCH/)
  term.keys('beta')
  await term.wait(/Description beta/)
  term.keys('\x1b[B\x1b[B\r')
  await term.wait(/INPUT/)
  term.keys('\t\x15bad\r')
  await term.wait(/Must say good/)
  term.keys('\x15good\r')
  await term.wait(/CONFIRM/)
  term.keys('maybe\r')
  await term.wait(/Enter yes or no/)
  term.keys('\x15n\r')
  await term.closed
  assert.match(
    term.output(),
    /RESULT {"picked":3,"found":"beta:2","value":"good","yes":false,"raw":false}/
  )
})

test('Esc aborts a back-enabled prompt and Ctrl+C cancels with terminal restored', async (t) => {
  const term = prompt(t, 'cancel')
  await term.wait(/BACK/)
  term.keys('\x1b')
  await term.wait(/BACK_RESULT AbortPromptError/)
  await term.wait(/CANCEL/)
  term.keys('\x03')
  await term.closed
  assert.match(term.output(), /ERROR ExitPromptError.*RAW false/)
})

test('input Enter accepts its default without editing', async (t) => {
  const term = prompt(t, 'default')
  await term.wait(/DEFAULT/)
  term.keys('\r')
  await term.closed
  assert.match(term.output(), /RESULT {"value":"kept","raw":false}/)
})

for (const mode of ['success', 'failure', 'cancel']) {
  test(`external editor ${mode} cleans files and handles quoted paths without shell expansion`, async (t) => {
    const dir = scratch(t),
      record = path.join(dir, 'record.json'),
      script = path.join(dir, 'fake editor.mjs')
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';fs.writeFileSync(process.env.RECORD,JSON.stringify({file:process.argv.at(-1),args:process.argv.slice(2,-1)}));${mode === 'success' ? `fs.writeFileSync(process.argv.at(-1),'{"edited":true}')` : mode === 'failure' ? 'process.exit(2)' : "console.log('EDITOR_RUNNING');setInterval(()=>{},1000)"}`
    )
    const command = `"${process.execPath}" "${script}" "argument with spaces" ";literal"`
    const term = prompt(t, 'editor', { EDITOR: command, VISUAL: command, RECORD: record })
    await term.wait(/EDITOR/)
    term.keys('\r')
    if (mode === 'cancel') {
      await term.wait(/EDITOR_RUNNING/)
      term.keys('\x03')
    }
    await term.closed
    const saved = JSON.parse(fs.readFileSync(record, 'utf8'))
    assert.deepEqual(saved.args, ['argument with spaces', ';literal'])
    assert.equal(fs.existsSync(path.dirname(saved.file)), false)
    if (mode === 'success') assert.match(term.output(), /edited/)
    else if (mode === 'failure') assert.match(term.output(), /Editor exited 2/)
    else assert.match(term.output(), /ExitPromptError/)
    assert.match(term.output(), /raw.*false|RAW false/)
  })
}

test('real configure wizard navigates back and cancels without writing', async (t) => {
  const dir = scratch(t)
  const term = terminal(t, ['sdk', 'configure'], { cwd: dir, rows: 32, cols: 110 })
  await term.waitFor(/What do you want to do/)
  term.keys('\r')
  await term.waitFor(/Capability/)
  term.keys('\x1b')
  await term.waitFor(/What do you want to do/)
  term.keys('\x03')
  await term.waitFor(/Cancelled.*nothing written/)
  assert.equal(fs.existsSync(path.join(dir, 'qvac.config.json')), false)
})

test('real configure wizard adds a model and writes only after Done', async (t) => {
  const dir = scratch(t)
  const term = terminal(t, ['sdk', 'configure'], { cwd: dir, rows: 36, cols: 110 })
  await term.waitFor(/What do you want to do/)
  term.keys('\r')
  await term.waitFor(/Capability/)
  term.keys('\r')
  await term.waitFor(/Pick a Chat/)
  term.keys('\r')
  await term.waitFor(/Proceed/)
  assert.equal(fs.existsSync(path.join(dir, 'qvac.config.json')), false)
  term.keys('\r')
  await term.waitFor(/What next/)
  assert.equal(fs.existsSync(path.join(dir, 'qvac.config.json')), false)
  term.keys('\x1b[B\x1b[B\r')
  const deadline = Date.now() + 10000
  while (!fs.existsSync(path.join(dir, 'qvac.config.json')) && Date.now() < deadline) {
    await sleep(20)
  }
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'qvac.config.json'), 'utf8'))
  assert.deepEqual(config.serve.models, {
    'qwen3-600m-inst-q4': { model: 'QWEN3_600M_INST_Q4', preload: false }
  })
})

test('small terminals bound wrapped choices and previews without stale rows', async (t) => {
  const term = prompt(t, 'bounds', {}, 9, 32)
  await term.wait(/Description old/)
  assert.match(term.screen.text(), /old result 0/)
  term.keys('fresh')
  await term.wait(/Description fresh/)
  assert.match(term.screen.text(), /fresh result 0/)
  assert.doesNotMatch(term.screen.text(), /old result|Description old/)
  term.keys('\x1b[B')
  await sleep(50)
  assert.match(term.screen.text(), /fresh result 1/)
  assert.match(term.screen.text(), /Description fresh/)
  term.keys('\r')
  await term.closed
  assert.match(term.output(), /RESULT 1/)
})
