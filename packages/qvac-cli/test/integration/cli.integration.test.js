const test = require('brittle')
const { QvacCliApp } = require('../../src/cli')

// Mock console output capture
const captureConsoleOutput = () => {
  const originalLog = console.log
  const originalError = console.error
  const output = { stdout: '', stderr: '' }

  console.log = (...args) => {
    output.stdout += args.join(' ') + '\n'
  }

  console.error = (...args) => {
    output.stderr += args.join(' ') + '\n'
  }

  return {
    output,
    restore: () => {
      console.log = originalLog
      console.error = originalError
    }
  }
}

// Test CLI app instantiation
test('should instantiate QvacCliApp without errors', async (t) => {
  t.execution(() => {
    return new QvacCliApp(true) // testing mode
  }, 'should instantiate QvacCliApp without errors')
})

// Test CLI app command structure
test('should have correct command structure', async (t) => {
  const { program } = require('commander')

  // Check main commands exist
  const commandNames = program.commands.map(cmd => cmd.name())
  t.ok(commandNames.includes('model'))
  t.ok(commandNames.includes('bootstrap'))

  // Check program properties
  t.is(program.name(), 'qvac')
  t.is(program.version(), '1.0.0')
  t.ok(program.description().includes('QVAC CLI - Command line interface for QVAC features'))
})

// Test model command and subcommands
test('should have model command with all subcommands and options', async (t) => {
  const { program } = require('commander')
  const modelCommand = program.commands.find(cmd => cmd.name() === 'model')

  t.ok(modelCommand)
  t.ok(modelCommand.description().includes('Manage QVAC models'))

  // Check all subcommands exist
  const subcommandNames = modelCommand.commands.map(cmd => cmd.name())
  t.ok(subcommandNames.includes('download'))
  t.ok(subcommandNames.includes('load'))
  t.ok(subcommandNames.includes('list'))
  t.ok(subcommandNames.includes('rm'))

  // Check download command options
  const downloadCommand = modelCommand.commands.find(cmd => cmd.name() === 'download')
  const downloadOptions = downloadCommand.options || []
  const hasHyperbeeOption = downloadOptions.some(opt =>
    opt.long === '--hyperbee-key' || opt.short === '-hbk'
  )
  t.ok(hasHyperbeeOption)

  // Check list command options
  const listCommand = modelCommand.commands.find(cmd => cmd.name() === 'list')
  const listOptions = listCommand.options || []
  const hasLocalOption = listOptions.some(opt => opt.long === '--local')
  const hasRemoteOption = listOptions.some(opt => opt.long === '--remote')
  t.ok(hasLocalOption)
  t.ok(hasRemoteOption)
})

// Test bootstrap command and subcommands
test('should have bootstrap command with package subcommand and options', async (t) => {
  const { program } = require('commander')
  const bootstrapCommand = program.commands.find(cmd => cmd.name() === 'bootstrap')

  t.ok(bootstrapCommand)
  t.ok(bootstrapCommand.description().includes('Bootstrap QVAC projects and packages'))

  // Check package subcommand exists
  const subcommandNames = bootstrapCommand.commands.map(cmd => cmd.name())
  t.ok(subcommandNames.includes('package'))

  // Check package command options
  const packageCommand = bootstrapCommand.commands.find(cmd => cmd.name() === 'package')
  const packageOptions = packageCommand.options || []
  const hasNameOption = packageOptions.some(opt => opt.long === '--name' || opt.short === '-n')
  const hasListOption = packageOptions.some(opt => opt.long === '--list' || opt.short === '-ls')
  t.ok(hasNameOption)
  t.ok(hasListOption)
})

// Test command execution
test('should execute model list command', async (t) => {
  const { program } = require('commander')
  const modelCommand = program.commands.find(cmd => cmd.name() === 'model')
  const listCommand = modelCommand.commands.find(cmd => cmd.name() === 'list')

  const capture = captureConsoleOutput()

  try {
    await listCommand.action({ local: true, remote: false })
  } catch (error) {
    // Expected to fail in test environment
    t.ok(error.message.includes('No local models') || error.message.includes('Error'))
  } finally {
    capture.restore()
  }
})

test('should execute bootstrap package command', async (t) => {
  const { program } = require('commander')
  const bootstrapCommand = program.commands.find(cmd => cmd.name() === 'bootstrap')
  const packageCommand = bootstrapCommand.commands.find(cmd => cmd.name() === 'package')

  const capture = captureConsoleOutput()

  try {
    await packageCommand.action({ name: undefined, list: true })
  } catch (error) {
    // Expected to fail in test environment
    t.ok(error.message.includes('Error') || error.message.includes('Failed'))
  } finally {
    capture.restore()
  }
})

// Test error handling
test('should handle missing environment variables gracefully', async (t) => {
  const originalEnv = process.env.QVAC_HYPERBEE_KEY
  delete process.env.QVAC_HYPERBEE_KEY

  t.execution(() => {
    return new QvacCliApp(true) // testing mode
  }, 'should handle missing environment variables gracefully')

  // Restore environment
  if (originalEnv) {
    process.env.QVAC_HYPERBEE_KEY = originalEnv
  }
})

test('should handle invalid environment variables gracefully', async (t) => {
  const originalEnv = process.env.QVAC_HYPERBEE_KEY
  process.env.QVAC_HYPERBEE_KEY = 'invalid-key'

  t.execution(() => {
    return new QvacCliApp(true) // testing mode
  }, 'should handle invalid environment variables gracefully')

  // Restore environment
  if (originalEnv) {
    process.env.QVAC_HYPERBEE_KEY = originalEnv
  } else {
    delete process.env.QVAC_HYPERBEE_KEY
  }
})

// Test CLI app configuration
test('should have correct configuration structure', async (t) => {
  const cli = new QvacCliApp(true) // testing mode

  // Check that the CLI app has the expected properties
  t.ok(cli.config !== undefined)
  t.ok(cli.storage !== undefined)
})

// Test CLI app run method
test('should handle run method with different arguments', async (t) => {
  const cli = new QvacCliApp(true) // testing mode

  // Test with empty arguments
  await t.execution(async () => {
    await cli.run([])
  }, 'should handle run method with empty arguments')

  // Test with help arguments
  await t.execution(async () => {
    await cli.run(['bare', 'cli.js', '--help'])
  }, 'should handle run method with help arguments')

  // Test with version arguments
  await t.execution(async () => {
    await cli.run(['bare', 'cli.js', '--version'])
  }, 'should handle run method with version arguments')
})
