'use strict'

// This file serves as a test runner for all unit tests
// It imports all test files to ensure they are executed

// Import all test files
require('./cli.unit.test.js')
require('./config.unit.test.js')
require('./storage.unit.test.js')
require('./fileParsers.unit.test.js')
require('./modelCache.unit.test.js')
require('./terminalLoader.unit.test.js')
require('./commands.unit.test.js')
require('./managers.unit.test.js')

console.log('All unit test files imported successfully')
