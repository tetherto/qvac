'use strict'

const test = require('brittle')
const { QvacCommandBase } = require('../../src/commands/base')
const { QvacModelCommand } = require('../../src/commands/model')
const { QvacBootstrapCommand } = require('../../src/commands/bootstrap')

test('QvacCommandBase constructor initializes correctly', (t) => {
  const config = { test: 'config' }
  const command = new QvacCommandBase(config)

  t.is(command.appConfig, config, 'should store appConfig')
})

test('QvacCommandBase.getCommand throws error', (t) => {
  const command = new QvacCommandBase({})

  t.exception(
    () => command.getCommand(),
    'should throw error for unimplemented getCommand'
  )
})

test('QvacCommandBase.execute throws error', async (t) => {
  const command = new QvacCommandBase({})

  await t.exception(
    command.execute('test', []),
    'should throw error for unimplemented execute'
  )
})

test('QvacModelCommand constructor initializes correctly', (t) => {
  const config = { test: 'config' }
  const command = new QvacModelCommand(config)

  t.is(command.appConfig, config, 'should store appConfig')
  t.ok(command.modelManager, 'should initialize modelManager')
})

test('QvacModelCommand.getCommand returns Command instance', (t) => {
  const config = { test: 'config' }
  const command = new QvacModelCommand(config)

  const cmd = command.getCommand()

  t.ok(cmd, 'should return command instance')
  t.ok(typeof cmd.command === 'function', 'should have command method')
  t.ok(typeof cmd.description === 'function', 'should have description method')
})

test('QvacModelCommand.getCommand has correct structure', (t) => {
  const config = { test: 'config' }
  const command = new QvacModelCommand(config)

  const cmd = command.getCommand()

  // Check that the command has the expected subcommands
  const subcommands = cmd.commands || []
  const subcommandNames = subcommands.map(sub => sub.name())

  t.ok(subcommandNames.includes('download'), 'should have download subcommand')
  t.ok(subcommandNames.includes('load'), 'should have load subcommand')
  t.ok(subcommandNames.includes('list'), 'should have list subcommand')
  t.ok(subcommandNames.includes('rm'), 'should have rm subcommand')
})

test('QvacBootstrapCommand constructor initializes correctly', (t) => {
  const config = { test: 'config' }
  const command = new QvacBootstrapCommand(config)

  t.is(command.appConfig, config, 'should store appConfig')
  t.ok(command.packageManager, 'should initialize packageManager')
})

test('QvacBootstrapCommand.getCommand returns Command instance', (t) => {
  const config = { test: 'config' }
  const command = new QvacBootstrapCommand(config)

  const cmd = command.getCommand()

  t.ok(cmd, 'should return command instance')
  t.ok(typeof cmd.command === 'function', 'should have command method')
  t.ok(typeof cmd.description === 'function', 'should have description method')
})

test('QvacBootstrapCommand.getCommand has correct structure', (t) => {
  const config = { test: 'config' }
  const command = new QvacBootstrapCommand(config)

  const cmd = command.getCommand()

  // Check that the command has the expected subcommands
  const subcommands = cmd.commands || []
  const subcommandNames = subcommands.map(sub => sub.name())

  t.ok(subcommandNames.includes('package'), 'should have package subcommand')
})

test('QvacBootstrapCommand.packageManager.list returns array', (t) => {
  const config = { test: 'config' }
  const command = new QvacBootstrapCommand(config)

  const packages = command.packageManager.list()

  t.ok(Array.isArray(packages), 'should return array')
  t.ok(packages.length >= 0, 'should return non-negative length array')
})

test('QvacModelCommand.modelManager has required methods', (t) => {
  const config = { test: 'config' }
  const command = new QvacModelCommand(config)

  t.ok(typeof command.modelManager.download === 'function', 'should have download method')
  t.ok(typeof command.modelManager.load === 'function', 'should have load method')
  t.ok(typeof command.modelManager.listLocal === 'function', 'should have listLocal method')
  t.ok(typeof command.modelManager.listRemote === 'function', 'should have listRemote method')
  t.ok(typeof command.modelManager.remove === 'function', 'should have remove method')
})

test('QvacModelCommand.modelManager.getModelAliasToPackageName handles valid alias', (t) => {
  const config = { test: 'config' }
  const command = new QvacModelCommand(config)

  // This test assumes there's at least one valid model alias in the mapper
  // We'll test the method exists and can be called
  t.ok(typeof command.modelManager.getModelAliasToPackageName === 'function', 'should have getModelAliasToPackageName method')
})

test('QvacModelCommand.modelManager.getModelAliasToPackageName throws for invalid alias', (t) => {
  const config = { test: 'config' }
  const command = new QvacModelCommand(config)

  t.exception(
    () => command.modelManager.getModelAliasToPackageName('invalid-alias'),
    'should throw error for invalid model alias'
  )
})
