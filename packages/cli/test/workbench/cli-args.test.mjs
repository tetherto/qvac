import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, UsageError } from '../../dist/cli/index.js'
import { envName, FLAGS } from '../../dist/cli/flags.js'

const parse = (argv, env = {}) => parseArgs(argv, { env })
const route = (argv, env) => {
  const { command, action, words, options } = parse(argv, env)
  return { command, action, words, options }
}
const fails = (fn, pattern) =>
  assert.throws(
    fn,
    (error) => error instanceof UsageError && error.code === 2 && pattern.test(error.message)
  )

test('qvac alone opens chat', () => {
  assert.deepEqual(parse([]), {
    command: 'chat',
    action: null,
    words: [],
    options: {},
    where: 'app'
  })
})

test('a first word that is not a command is the first chat message', () => {
  const { command, words } = parse(['explain', 'this', 'repo'])
  assert.equal(command, 'chat')
  assert.deepEqual(words, ['explain', 'this', 'repo'])
})

test('every reserved word dispatches instead of becoming a prompt', () => {
  assert.equal(parse(['serve']).command, 'serve')
  assert.equal(parse(['status']).command, 'status')
  assert.equal(parse(['logs', '-f']).command, 'logs')
  assert.equal(parse(['chat', 'hello']).command, 'chat')
  assert.equal(parse(['chat']).action, 'open')
  assert.equal(parse(['help']).command, 'help')
  assert.deepEqual(parse(['workspace', 'join', 'qvac://x']).words, ['qvac://x'])
  assert.equal(parse(['models', 'list']).action, 'list')
  assert.equal(parse(['config']).command, 'config')
  assert.equal(parse(['config', '--config', 'x.json']).options.configFile, 'x.json')
  for (const word of ['help', 'sdk']) {
    assert.equal(parse([word, 'please']).command, word)
  }

  for (const word of ['serve', 'status', 'logs', 'config']) {
    fails(() => parse([word, 'please']), new RegExp(`unexpected "please": qvac ${word}`))
  }

  fails(() => parse(['workspace', 'please']), /workspace takes/)
  fails(() => parse(['host', 'please']), /host takes/)
})

test('a command word after flags still dispatches', () => {
  const { command, options } = parse(['--temp', '--fake-models', 'status'])
  assert.equal(command, 'status')
  assert.deepEqual(options, { temp: true, fakeModels: true })
})

test('host serve is serve', () => {
  const parsed = parse(['host', 'serve', '--json'])
  assert.equal(parsed.command, 'serve')
  assert.equal(parsed.options.json, true)
  fails(() => parse(['host']), /host takes one command: serve/)
})

test('sdk forwards everything after it untouched', () => {
  assert.deepEqual(route(['sdk', 'serve', '--port', '3000']), {
    command: 'sdk',
    action: null,
    words: ['serve', '--port', '3000'],
    options: {}
  })
})

test('serve is never the SDK server', () => {
  assert.equal(parse(['serve']).command, 'serve')
})

test('help and version', () => {
  assert.equal(parse(['--help']).command, 'help')
  assert.deepEqual(parse(['-h']).words, [])
  assert.deepEqual(parse(['help', 'models']).words, ['models'])
  assert.deepEqual(parse(['serve', '--help']).words, ['serve'])
  assert.deepEqual(parse(['workspace', 'join', '-h']).words, ['workspace', 'join'])
  assert.equal(parse(['--version']).command, 'version')
  assert.equal(parse(['-v']).command, 'version')
})

test('unknown subcommands and options are usage errors', () => {
  fails(() => parse(['models', 'nuke']), /models takes list, pull, remove/)
  fails(() => parse(['workspace']), /workspace takes create, join, leave/)
  fails(() => parse(['--frobnicate']), /unknown option --frobnicate/)
  fails(() => parse(['serve', '--join']), /missing value for --join/)
  fails(() => parse(['serve', '--join', '--yes']), /missing value for --join/)
})

test('value flags take the next argument or an inline value', () => {
  assert.equal(parse(['serve', '--account-name', 'Ada']).options.accountName, 'Ada')
  assert.equal(parse(['serve', '--account-name=Ada Lovelace']).options.accountName, 'Ada Lovelace')
  assert.equal(parse(['serve', '-s', '/tmp/x']).options.dataDir, '/tmp/x')
  assert.equal(parse(['serve', '--name', 'box']).options.deviceName, 'box')
  assert.equal(parse(['serve', '--storage', '/a']).options.dataDir, '/a')
})

test('-- ends the options, and a leading one makes the rest a chat message', () => {
  assert.deepEqual(parse(['--', '-x', 'serve']).words, ['-x', 'serve'])
  assert.equal(parse(['--', 'status', 'of', 'the', 'build']).command, 'chat')
  assert.equal(parse(['--temp', '--', 'status']).command, 'chat')
  assert.deepEqual(parse(['chat', '--', '-x']).words, ['-x'])
})

test('every flag reads QVAC_<FLAG_NAME>', () => {
  const { options } = parse(['serve'], {
    QVAC_JOIN: 'qvac://workspace/abc',
    QVAC_ACCOUNT_NAME: 'Ada',
    QVAC_DATA_DIR: '/srv/qvac',
    QVAC_NON_INTERACTIVE: '1',
    QVAC_JSON: 'true',
    QVAC_NO_DEFAULT_MODELS: 'yes',
    QVAC_YES: '0',
    QVAC_TAIL: '10'
  })
  assert.deepEqual(options, {
    join: 'qvac://workspace/abc',
    accountName: 'Ada',
    dataDir: '/srv/qvac',
    nonInteractive: true,
    json: true,
    noDefaultModels: true,
    yes: false,
    tail: 10
  })
})

test('env names are derived from every flag, help and version excepted', () => {
  assert.equal(envName({ name: 'device-join' }), 'QVAC_DEVICE_JOIN')
  const expected = { tail: 7 }
  for (const flag of FLAGS.filter((f) => !['help', 'version'].includes(f.name))) {
    const { options } = parse(['status'], { [envName(flag)]: flag.value ? '7' : '1' })
    const value = flag.value ? (expected[flag.key] ?? '7') : true
    assert.equal(options[flag.key], value, flag.name)
  }

  assert.equal(parse([], { QVAC_HELP: '1' }).command, 'chat')
  assert.equal(parse([], { QVAC_VERSION: '1' }).command, 'chat')
})

test('a flag on the command line beats its env var', () => {
  const { options } = parse(['serve', '--device-name', 'cli'], { QVAC_DEVICE_NAME: 'env' })
  assert.equal(options.deviceName, 'cli')
})

test('the device name reads QVAC_NAME too', () => {
  assert.equal(parse(['serve'], { QVAC_NAME: 'gpu-1' }).options.deviceName, 'gpu-1')
})

test('NO_COLOR turns colour off', () => {
  assert.equal(parse(['status'], { NO_COLOR: '' }).options.noColor, true)
})

test('--tail takes a whole number', () => {
  assert.equal(parse(['logs', '--tail', '0']).options.tail, 0)
  fails(() => parse(['logs', '--tail', 'lots']), /whole number/)
})

test('commands take exactly their words', () => {
  parse(['status'])
  parse(['models', 'pull', 'quack'])
  parse(['workspace', 'leave'])
  fails(() => parse(['status', 'of', 'things']), /unexpected "of things": qvac status/)
  fails(() => parse(['models', 'pull']), /missing <model>: qvac models pull <model>/)
  fails(() => parse(['workspace', 'join']), /missing <link>/)
})

test('a flag between the words of a chat message is still a flag', () => {
  const { command, words, options } = parse(['explain', '--yes', 'this'])
  assert.equal(command, 'chat')
  assert.deepEqual(words, ['explain', 'this'])
  assert.equal(options.yes, true)
})

test('each command runs where it says: the launcher, Core in the app, or the app', () => {
  assert.equal(parse(['config']).where, 'launcher')
  assert.equal(parse(['workspace', 'join', 'qvac://x']).where, 'core')
  assert.equal(parse(['host', 'serve']).where, 'core')
  assert.equal(parse(['hello']).where, 'app')
})
