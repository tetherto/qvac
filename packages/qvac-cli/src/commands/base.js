'use strict'

class QvacCommandBase {
  constructor (appConfig) {
    this.appConfig = appConfig
  }

  getCommand () {
    throw new Error('getCommand() must be implemented')
  }

  async execute (subCommand, args) {
    throw new Error('execute() must be implemented')
  }
}

module.exports = { QvacCommandBase }
