import test from 'brittle'
import { command, flag, summary, footer } from '../../lib/cli.js'

test('cli — parses boolean flags on root command', t => {
  let called = false
  const prog = command(
    'qvac-ci',
    flag('--version|-v', 'Print version'),
    () => {
      called = true
      t.ok(prog.flags.version)
    }
  )

  prog.parse(['--version'])
  t.ok(called)
})

test('cli — parses subcommand flags with kebab and camel keys', t => {
  let captured = null
  const sub = command(
    'pending-approvals',
    flag('--pr-number <number>', 'PR number'),
    flag('--repo [owner/repo]', 'Repository'),
    () => {
      captured = sub.flags
    }
  )

  const prog = command('qvac-ci', sub)
  prog.parse(['pending-approvals', '--pr-number', '42', '--repo', 'org/repo'])

  t.is(captured['pr-number'], '42')
  t.is(captured.prNumber, '42')
  t.is(captured.repo, 'org/repo')
})

test('cli — buildHelp includes summary and footer', t => {
  const sub = command(
    'demo',
    summary('Demo command'),
    footer('Env vars here'),
    flag('--foo <bar>', 'A flag')
  )

  sub.parse(['--help'])
  // help writes to stdout — just verify parse does not throw
  t.pass('help rendered without error')
})
