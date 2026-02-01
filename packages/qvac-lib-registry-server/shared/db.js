'use strict'

const ReadyResource = require('ready-resource')
const HyperDB = require('hyperdb')

const { QVAC_MAIN_REGISTRY } = require('./constants')
const dbSpec = require('./spec/hyperdb')

class RegistryDatabase extends ReadyResource {
  constructor (core, { extension = true } = {}) {
    super()
    this.db = HyperDB.bee(core, dbSpec, { autoUpdate: true, extension })
  }

  get core () {
    return this.db.core
  }

  get publicKey () {
    return this.db.core.key
  }

  get discoveryKey () {
    return this.db.core.discoveryKey
  }

  async _open () {
    await this.db.ready()
  }

  async _close () {
    await this.db.close()
  }

  async putModel (record) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.insert(`@${QVAC_MAIN_REGISTRY}/model`, record)
    await tx.flush()
  }

  async getModel (path, source) {
    if (!this.opened) await this.ready()
    if (source) {
      return this.db.get(`@${QVAC_MAIN_REGISTRY}/model`, { path, source })
    }
    // When source is not provided, use find with path filter and return first match
    const results = await this.db.find(`@${QVAC_MAIN_REGISTRY}/model`, {
      gte: { path },
      lte: { path }
    }).toArray()
    return results[0] || null
  }

  async deleteModel (path, source) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.delete(`@${QVAC_MAIN_REGISTRY}/model`, { path, source })
    await tx.flush()
  }

  findModelsByPath (query = {}) {
    return this.db.find(`@${QVAC_MAIN_REGISTRY}/model`, query)
  }

  findModelsByEngine (query = {}) {
    return this.db.find(`@${QVAC_MAIN_REGISTRY}/models-by-engine`, query)
  }

  findModelsByName (query = {}) {
    return this.db.find(`@${QVAC_MAIN_REGISTRY}/models-by-name`, query)
  }

  findModelsByQuantization (query = {}) {
    return this.db.find(`@${QVAC_MAIN_REGISTRY}/models-by-quantization`, query)
  }

  async putLicense (record) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.insert(`@${QVAC_MAIN_REGISTRY}/license`, record)
    await tx.flush()
  }

  async getLicense (spdxId) {
    if (!this.opened) await this.ready()
    return this.db.get(`@${QVAC_MAIN_REGISTRY}/license`, { spdxId })
  }

  findLicenses (query = {}) {
    return this.db.find(`@${QVAC_MAIN_REGISTRY}/license`, query)
  }
}

module.exports = RegistryDatabase
