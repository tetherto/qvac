'use strict'

const { Command } = require('commander')
const { QvacCommandBase } = require('./base')

const { loader } = require('../utils/terminalLoader')
const { QvacPackageManager } = require('../managers/packageManager')

class QvacBootstrapCommand extends QvacCommandBase {
  constructor (appConfig) {
    super(appConfig)
    this.packageManager = new QvacPackageManager(appConfig)
  }

  getCommand () {
    const command = new Command('bootstrap')
      .description('Bootstrap QVAC projects and packages')

    command
      .command('package')
      .description('Sets up a qvac package for development')
      .option('-n, --name <name>', 'Name of the package to bootstrap')
      .option('-ls, --list', 'List all packages available for bootstrap')
      .action(async (options) => {
        const packageName = options.name

        if (!packageName || options.list) {
          const packages = this.packageManager.list()

          for (const pkg of packages) {
            console.log(`- ${pkg}`)
          }
          return
        }

        try {
          loader.start(`Bootstrapping package ${packageName}...`)

          await this.packageManager.bootstrap(packageName)

          await loader.succeed(`Package ${packageName} successfully bootstrapped`)
        } catch (error) {
          await loader.fail(`Failed to bootstrap package: ${error}`)
        }
      })

    return command
  }
}

module.exports = { QvacBootstrapCommand }
