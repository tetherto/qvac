'use strict'

const { program } = require('commander')
const { QvacStorage } = require('./utils/storage')
const { QvacModelCommand } = require('./commands/model')
const { QvacBootstrapCommand } = require('./commands/bootstrap')
const { parseEnvVars } = require('./utils/config')

class QvacCliApp {
  constructor (testing = false) {
    this.config = parseEnvVars()
    this.storage = QvacStorage.getInstance()
    this.setupCommands(testing)
  }

  setupCommands (testing) {
    if (testing) {
      program.exitOverride()
    }

    program
      .name('qvac')
      .description('QVAC CLI - Command line interface for QVAC features')
      .version('1.0.0')

    program.addCommand(new QvacModelCommand(this.config).getCommand())
    program.addCommand(new QvacBootstrapCommand(this.config).getCommand())

    if (testing) {
      try {
        program.parse()
      } catch (error) {
        console.log('program.parse expected error for test: ', error)
      }
    } else {
      program.parse()
    }
  }

  async run (argv) {
    // Commander handles the argument parsing
    if (argv.length === 2) {
      program.help()
    }
  }
}

module.exports = { QvacCliApp }
