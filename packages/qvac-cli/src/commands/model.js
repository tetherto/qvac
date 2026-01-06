'use strict'

const { Command } = require('commander')
const { QvacCommandBase } = require('./base')
const { QvacModelManager } = require('../managers/modelManager')
const { loader } = require('../utils/terminalLoader')

class QvacModelCommand extends QvacCommandBase {
  constructor (appConfig) {
    super(appConfig)
    this.modelManager = new QvacModelManager(appConfig)
  }

  getCommand () {
    const command = new Command('model')
      .description('Manage QVAC models')

    command
      .command('download <modelAlias>')
      .description('Download model and related libraries from HyperBee')
      .option('-hbk, --hyperbee-key <hyperbee-key>', 'Specific hyperbee key to download')
      .action(async (modelAlias, options) => {
        try {
          loader.start(`Downloading model ${modelAlias}...`)
          await this.modelManager.download(modelAlias, options.hyperbeeKey)
          await loader.succeed(`Model ${modelAlias} successfully downloaded`)
        } catch (error) {
          await loader.fail(`Failed to download model: ${error.message}`)
        }
      })

    command
      .command('load <modelAlias>')
      .description('Load a model into memory and launch REPL inference')
      .action(async (modelAlias) => {
        try {
          loader.start(`Loading model ${modelAlias}...`)
          const loadResponse = await this.modelManager.load(modelAlias)
          await loader.succeed('Model loaded')
          console.log('Entering inference chat mode. Type \'exit\' to quit.')
          await this.modelManager.startRepl(modelAlias, loadResponse)
        } catch (error) {
          await loader.fail(`Failed to load model: ${error.message}`)
        }
      })

    command
      .command('list')
      .description('List available models')
      .option('--local', 'List local models')
      .option('--remote', 'List remote models')
      .action(async (options) => {
        try {
          loader.start('Listing models...')
          if (options.local) {
            const localModels = await this.modelManager.listLocal()
            if (localModels.length === 0) {
              await loader.fail('No local models found')
            } else {
              await loader.succeed('Local models:')
              localModels.forEach(model => console.log(`- ${model}`))
            }
          } else if (options.remote) {
            const remoteModels = await this.modelManager.listRemote()
            if (remoteModels.length === 0) {
              await loader.fail('No remote models found')
            } else {
              await loader.succeed('Remote models:')
              remoteModels.forEach(model => console.log(`- ${model}`))
            }
          } else {
            await loader.fail('Please specify --local or --remote')
          }
        } catch (error) {
          await loader.fail(`Error listing models: ${error.message}`)
        }
      })

    command
      .command('rm <modelAlias>')
      .description('Remove a model and its persistent data')
      .action(async (modelAlias) => {
        try {
          await this.modelManager.remove(modelAlias)
          console.log(`Model ${modelAlias} removed`)
        } catch (error) {
          console.error(`Failed to remove model: ${error.message}`)
        }
      })

    return command
  }
}

module.exports = { QvacModelCommand }
