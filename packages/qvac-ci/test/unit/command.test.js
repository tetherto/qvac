import test from 'brittle'
import { Command } from '../../lib/command.js'

// Command base class contracts

test('Command — constructor stores name, description, and secrets', t => {
  const cmd = new Command({
    name: 'my-cmd',
    description: 'does something',
    secrets: [{ envVar: 'MY_TOKEN', description: 'A token' }]
  })
  t.is(cmd.name, 'my-cmd')
  t.is(cmd.description, 'does something')
  t.is(cmd.secrets.length, 1)
  t.is(cmd.secrets[0].envVar, 'MY_TOKEN')
})

test('Command — secrets defaults to empty array', t => {
  const cmd = new Command({ name: 'x', description: 'y' })
  t.alike(cmd.secrets, [])
})

test('Command — toCommand() throws if not overridden', async t => {
  const cmd = new Command({ name: 'x', description: 'y' })
  await t.exception.all(async () => cmd.toCommand())
})

test('Command — _run() throws if not overridden', async t => {
  const cmd = new Command({ name: 'x', description: 'y' })
  await t.exception(async () => cmd._run({}))
})

test('Command — run() validates required env vars before calling _run()', async t => {
  const envVar = 'TEST_RUN_SECRET_' + Date.now()
  delete process.env[envVar]

  const cmd = new Command({ name: 'x', description: 'y', secrets: [{ envVar, description: 'test' }] })
  // _run() is not implemented — but it should never be reached
  await t.exception(async () => cmd.run({}), 'should throw due to missing env var')
})

test('Command — run() calls _run() when secrets are present', async t => {
  const envVar = 'TEST_RUN_OK_' + Date.now()
  process.env[envVar] = 'fake-value'

  let called = false
  class TestCmd extends Command {
    async _run (flags) { called = true }
  }
  const cmd = new TestCmd({ name: 'x', description: 'y', secrets: [{ envVar, description: 'test' }] })
  await cmd.run({})
  t.ok(called)

  delete process.env[envVar]
})

// _secretsFooter

test('_secretsFooter — returns empty string for no secrets', t => {
  const cmd = new Command({ name: 'x', description: 'y' })
  t.is(cmd._secretsFooter(), '')
})

test('_secretsFooter — returns formatted env var list', t => {
  const cmd = new Command({
    name: 'x',
    description: 'y',
    secrets: [
      { envVar: 'GITHUB_TOKEN', description: 'A token' },
      { envVar: 'GITHUB_APP_ID', description: 'App ID' }
    ]
  })
  const footer = cmd._secretsFooter()
  t.ok(footer.includes('GITHUB_TOKEN'))
  t.ok(footer.includes('GITHUB_APP_ID'))
  t.ok(footer.includes('Environment (required)'))
})
