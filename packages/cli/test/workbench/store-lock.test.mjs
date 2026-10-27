import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const bare = createRequire(import.meta.url)('bare-runtime')()
const fixture = new URL('./fixtures/store-lock.mjs', import.meta.url).pathname
const check = (dir) => spawnSync(bare, [fixture, 'check', dir], { encoding: 'utf8' }).stdout.trim()

test('a store another process holds is in use, so no second Core opens it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-lock-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.chmodSync(bare, 0o755)
  assert.equal(check(dir), 'false', 'no store yet')

  fs.writeFileSync(path.join(dir, 'CORESTORE'), '')
  assert.equal(check(dir), 'false', 'a store nobody holds')

  const holder = spawn(bare, [fixture, 'hold', dir])
  await new Promise((resolve) => holder.stdout.once('data', resolve))
  assert.equal(check(dir), 'true', 'held by a running qvac')

  holder.kill()
  await new Promise((resolve) => holder.once('exit', resolve))
  assert.equal(check(dir), 'false', 'free again once it stops')
})
