import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../../src/route.js'

describe('route', () => {
  it('prints help on --help, -h and help, and as an error with no command', () => {
    assert.deepEqual(route([]), { kind: 'help', exitCode: 1 })
    for (const argv of [['--help'], ['-h'], ['help']]) {
      assert.deepEqual(route(argv), { kind: 'help', exitCode: 0 })
    }
  })

  it('prints the version on --version and -V', () => {
    assert.deepEqual(route(['--version']), { kind: 'version' })
    assert.deepEqual(route(['-V']), { kind: 'version' })
  })

  it('passes everything after sdk to the SDK tools unchanged', () => {
    assert.deepEqual(route(['sdk']), { kind: 'sdk', args: [] })
    assert.deepEqual(route(['sdk', 'serve', '--openai', '--port', '0']), {
      kind: 'sdk',
      args: ['serve', '--openai', '--port', '0']
    })
    assert.deepEqual(route(['sdk', '--help']), { kind: 'sdk', args: ['--help'] })
  })

  it('runs the earlier top-level commands under sdk and names the new form', () => {
    for (const command of ['configure', 'doctor', 'openai', 'serve', 'verify']) {
      assert.deepEqual(route([command, '--flag', 'value']), {
        kind: 'sdk',
        args: [command, '--flag', 'value'],
        deprecation: { used: `qvac ${command}`, replacement: `qvac sdk ${command}` }
      })
    }
  })

  it('maps bundle sdk to the flat bundle command', () => {
    assert.deepEqual(route(['bundle', 'sdk', '--host', 'linux-x64']), {
      kind: 'sdk',
      args: ['bundle', '--host', 'linux-x64'],
      deprecation: { used: 'qvac bundle sdk', replacement: 'qvac sdk bundle' }
    })
    assert.deepEqual(route(['bundle', '--help']), {
      kind: 'sdk',
      args: ['bundle', '--help'],
      deprecation: { used: 'qvac bundle', replacement: 'qvac sdk bundle' }
    })
  })

  it('treats help <command> as <command> --help', () => {
    assert.deepEqual(route(['help', 'sdk']), { kind: 'sdk', args: ['--help'] })
    assert.deepEqual(route(['help', 'serve']), {
      kind: 'sdk',
      args: ['serve', '--help'],
      deprecation: { used: 'qvac serve', replacement: 'qvac sdk serve' }
    })
  })

  it('rejects unknown commands and options', () => {
    assert.deepEqual(route(['chat']), { kind: 'error', message: "unknown command 'chat'" })
    assert.deepEqual(route(['help', 'chat']), { kind: 'error', message: "unknown command 'chat'" })
    assert.deepEqual(route(['--port', '0']), { kind: 'error', message: "unknown option '--port'" })
  })
})
