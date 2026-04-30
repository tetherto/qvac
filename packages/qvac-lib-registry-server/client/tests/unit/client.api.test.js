'use strict'

const test = require('brittle')

test('client api surface', async t => {
  const { QVACRegistryClient } = require('../../index')
  t.ok(QVACRegistryClient, 'QVACRegistryClient class exists')

  t.ok(typeof QVACRegistryClient === 'function', 'QVACRegistryClient is a constructor')
  t.ok(QVACRegistryClient.prototype.getModel, 'has getModel method')
  t.ok(QVACRegistryClient.prototype.downloadModel, 'has downloadModel method')
  t.ok(QVACRegistryClient.prototype.downloadBlob, 'has downloadBlob method')
  t.ok(QVACRegistryClient.prototype.findModels, 'has findModels method')
  t.ok(QVACRegistryClient.prototype.findModelsByEngine, 'has findModelsByEngine method')
  t.ok(QVACRegistryClient.prototype.findModelsByName, 'has findModelsByName method')
  t.ok(QVACRegistryClient.prototype.findModelsByQuantization, 'has findModelsByQuantization method')
  t.ok(QVACRegistryClient.prototype.findBy, 'has findBy method')
  t.ok(QVACRegistryClient.prototype.ready, 'has ready method')
  t.ok(QVACRegistryClient.prototype.close, 'has close method')
  t.ok(QVACRegistryClient.prototype.suspend, 'has suspend method')
  t.ok(QVACRegistryClient.prototype.resume, 'has resume method')
})

test('client find methods are async functions', async t => {
  const QVACRegistryClient = require('../../lib/client')

  t.ok(QVACRegistryClient.prototype.findModels.constructor.name === 'AsyncFunction', 'findModels is async')
  t.ok(QVACRegistryClient.prototype.findModelsByEngine.constructor.name === 'AsyncFunction', 'findModelsByEngine is async')
  t.ok(QVACRegistryClient.prototype.findModelsByName.constructor.name === 'AsyncFunction', 'findModelsByName is async')
  t.ok(QVACRegistryClient.prototype.findModelsByQuantization.constructor.name === 'AsyncFunction', 'findModelsByQuantization is async')
  t.ok(QVACRegistryClient.prototype.findBy.constructor.name === 'AsyncFunction', 'findBy is async')
  t.ok(QVACRegistryClient.prototype.suspend.constructor.name === 'AsyncFunction', 'suspend is async')
  t.ok(QVACRegistryClient.prototype.resume.constructor.name === 'AsyncFunction', 'resume is async')
})
