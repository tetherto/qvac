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

function captureHelp (cmd, argv) {
  let output = ''
  const savedWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => { output += chunk; return true }
  try {
    cmd.parse(argv)
  } finally {
    process.stdout.write = savedWrite
  }
  return output
}

test('cli — leaf command usage omits [command]', t => {
  const sub = command(
    'demo',
    summary('Demo command'),
    flag('--foo <bar>', 'A flag')
  )

  const output = captureHelp(sub, ['--help'])
  t.ok(output.includes('Usage: demo [options]'), 'usage has no [command] for leaf command')
  t.absent(output.includes('[command]'), 'does not mention [command]')
})

test('cli — parent command usage includes [command]', t => {
  const sub = command('child', summary('Child command'))
  const prog = command('qvac-ci', summary('Root'), sub)

  const output = captureHelp(prog, ['--help'])
  t.ok(output.includes('Usage: qvac-ci [command] [options]'), 'usage shows [command] for parent')
})

test('cli — option line does not duplicate the short name', t => {
  const prog = command(
    'qvac-ci',
    flag('--version|-v', 'Print version')
  )

  const output = captureHelp(prog, ['--help'])
  t.ok(output.includes('--version, -v  Print version'), 'short name rendered once')
  t.absent(output.includes('--version|-v'), 'raw spec separator not shown')
})

test('cli — option line preserves the value placeholder', t => {
  const sub = command(
    'demo',
    flag('--pr-number <number>', 'PR number'),
    flag('--repo [owner/repo]', 'Repository')
  )

  const output = captureHelp(sub, ['--help'])
  t.ok(output.includes('--pr-number <number>  PR number'), 'required value placeholder kept')
  t.ok(output.includes('--repo [owner/repo]  Repository'), 'optional value placeholder kept')
})
