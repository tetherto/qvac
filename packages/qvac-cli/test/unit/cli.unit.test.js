'use strict'

const test = require('brittle')
const { QvacCliApp } = require('../../src/cli')

function getTestCliApp () {
  return new QvacCliApp(true)
}

test('QvacCliApp constructor initializes correctly', (t) => {
  const app = getTestCliApp()

  t.ok(app.config, 'config should be initialized')
  t.ok(app.storage, 'storage should be initialized')
  t.ok(typeof app.setupCommands === 'function', 'setupCommands should be a function')
  t.ok(typeof app.run === 'function', 'run should be a function')
})

test('QvacCliApp.run handles empty argv correctly', async (t) => {
  const app = getTestCliApp()

  // Mock program.help to avoid actual help output
  const originalHelp = app.program?.help
  if (app.program) {
    app.program.help = () => {}
  }

  try {
    await app.run([])
    t.pass('run should complete without error for empty argv')
  } catch (error) {
    t.fail(`run should not throw error: ${error.message}`)
  } finally {
    if (app.program && originalHelp) {
      app.program.help = originalHelp
    }
  }
})

test('QvacCliApp.run handles non-empty argv correctly', async (t) => {
  const app = getTestCliApp()

  try {
    await app.run(['bare', 'qvac', '--help'])
    t.pass('run should complete without error for non-empty argv')
  } catch (error) {
    t.fail(`run should not throw error: ${error.message}`)
  }
})
