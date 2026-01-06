'use strict'

const test = require('brittle')
const { TerminalLoader } = require('../../src/utils/terminalLoader')

test('TerminalLoader constructor creates singleton', (t) => {
  const loader1 = new TerminalLoader()
  const loader2 = new TerminalLoader()

  t.is(loader1, loader2, 'should return the same instance')
})

test('TerminalLoader has required properties', (t) => {
  const loader = new TerminalLoader()

  t.ok(Array.isArray(loader.frames), 'should have frames array')
  t.ok(typeof loader.frameIndex === 'number', 'should have frameIndex')
  t.ok(typeof loader.isSpinning === 'boolean', 'should have isSpinning')
  t.ok(typeof loader.text === 'string' || loader.text === undefined, 'should have text property')
})

test('TerminalLoader.start sets up spinner correctly', (t) => {
  const loader = new TerminalLoader()
  const testText = 'Test loading...'

  loader.start(testText)

  t.is(loader.text, testText, 'should set text')
  t.is(loader.isSpinning, true, 'should set isSpinning to true')
  t.ok(loader.interval, 'should set interval')

  // Cleanup
  loader.stop()
})

test('TerminalLoader.stop stops spinner correctly', (t) => {
  const loader = new TerminalLoader()

  loader.start('Test text')
  t.is(loader.isSpinning, true, 'should be spinning after start')

  loader.stop()
  t.is(loader.isSpinning, false, 'should not be spinning after stop')
})

test('TerminalLoader.succeed stops spinner and logs success', async (t) => {
  const loader = new TerminalLoader()
  const testText = 'Success message'

  // Mock console.log to capture output
  const originalLog = console.log
  let loggedMessage = ''
  console.log = (msg) => { loggedMessage = msg }

  try {
    loader.start('Loading...')
    loader.succeed(testText)

    // wait for 0.5 second
    await new Promise(resolve => setTimeout(resolve, 500))

    t.is(loader.isSpinning, false, 'should stop spinning')
    t.ok(loggedMessage.includes('✓'), 'should log success symbol')
    t.ok(loggedMessage.includes(testText), 'should log success message')
  } finally {
    console.log = originalLog
  }
})

test('TerminalLoader.fail stops spinner and logs failure', async (t) => {
  const loader = new TerminalLoader()
  const testText = 'Failure message'

  // Mock console.log to capture output
  const originalLog = console.log
  let loggedMessage = ''
  console.log = (msg) => { loggedMessage = msg }

  try {
    loader.start('Loading...')
    loader.fail(testText)

    // wait for 0.5 second
    await new Promise(resolve => setTimeout(resolve, 500))

    t.is(loader.isSpinning, false, 'should stop spinning')
    t.ok(loggedMessage.includes('✖'), 'should log failure symbol')
    t.ok(loggedMessage.includes(testText), 'should log failure message')
  } finally {
    console.log = originalLog
  }
})

test('TerminalLoader.warn stops spinner and logs warning', async (t) => {
  const loader = new TerminalLoader()
  const testText = 'Warning message'

  // Mock console.log to capture output
  const originalLog = console.log
  let loggedMessage = ''
  console.log = (msg) => { loggedMessage = msg }

  try {
    loader.start('Loading...')
    loader.warn(testText)

    // wait for 0.5 second
    await new Promise(resolve => setTimeout(resolve, 500))

    t.is(loader.isSpinning, false, 'should stop spinning')
    t.ok(loggedMessage.includes('⚠'), 'should log warning symbol')
    t.ok(loggedMessage.includes(testText), 'should log warning message')
  } finally {
    console.log = originalLog
  }
})

test('TerminalLoader frameIndex cycles correctly', (t) => {
  const loader = new TerminalLoader()

  loader.start('Test')

  const initialIndex = loader.frameIndex
  const frameCount = loader.frames.length

  // Simulate multiple frame updates
  for (let i = 0; i < frameCount + 1; i++) {
    loader.frameIndex = (loader.frameIndex + 1) % frameCount
  }

  t.is(loader.frameIndex, (initialIndex + 1) % frameCount, 'frameIndex should cycle correctly')

  loader.stop()
})
