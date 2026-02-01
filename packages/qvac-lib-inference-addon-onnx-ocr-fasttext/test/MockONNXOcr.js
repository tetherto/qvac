'use strict'

const AddonInterface = require('./MockAddon')
const QvacResponse = require('@qvac/response')
const fs = require('bare-fs')
const { transitionCb } = require('./utils.js')

const END_OF_INPUT = 'end of job'

class ONNXOcr {
  _jobToResponse = new Map()

  constructor (args) {
    this.args = args
    this.addon = null
  }

  async load (close = false) {
    const configurationParams = {
      config: this.config
    }
    this.addon = this.createAddon(configurationParams)
    await this.addon.activate()
  }

  async run (input) {
    return this._runInternal(input)
  }

  async pause () {
    await this.addon.pause()
  }

  async unpause () {
    await this.addon.activate()
  }

  async stop () {
    await this.addon.stop()
  }

  async status () {
    return this.addon.status()
  }

  createAddon (configurationParams) {
    return new AddonInterface(
      configurationParams,
      this.outputCallback.bind(this),
      transitionCb
    )
  }

  outputCallback (addon, event, jobId, data, error) {
    const response = this._jobToResponse.get(jobId)
    if (event === 'Error') {
      console.log('Callback called with error. ', error)
      response.failed(error)
      this.deleteJobMapping(jobId)
    } else if (event === 'Output') {
      console.log(`Callback called for job: ${jobId} with data: ${dataAsString(data)}`)
      response.updateOutput(data)
    } else if (event === 'JobEnded') {
      console.log(`Callback called for job end: ${jobId}. Stats: ${JSON.stringify(data)}`)
      if (this.opts?.stats) {
        response.updateStats(data)
      }
      response.ended()
      this.deleteJobMapping(jobId)
    } else {
      console.log('jobId: ' + jobId + ', event: ' + event)
    }
  }

  saveJobToResponseMapping (jobId, response) {
    this._jobToResponse.set(jobId, response)
  }

  deleteJobMapping (jobId) {
    this._jobToResponse.delete(jobId)
  }

  async _runInternal (input) {
    const imageInput = this.getImage(input.path)
    const jobId = await this.addon.append({ type: 'image', input: imageInput, options: input.options })
    const response = new QvacResponse({
      cancelHandler: () => {
        return this.addon.cancel(jobId)
      },
      pauseHandler: () => {
        return this.addon.pause()
      },
      continueHandler: () => {
        return this.addon.activate()
      }
    })
    this.saveJobToResponseMapping(jobId, response)
    await this.addon.append({ type: END_OF_INPUT })
    return response
  }

  getImage (imagePath) {
    const contents = fs.readFileSync(imagePath)
    if (!contents || contents.length < 14 + 4) {
      throw new Error('Invalid BMP file or insufficient data')
    }

    if (contents[0] !== 0x42 || contents[1] !== 0x4D) {
      throw new Error('Not a valid BMP file')
    }

    const infoHeaderSize = contents.readUInt32LE(14)

    if (contents.length < 14 + infoHeaderSize) {
      throw new Error('Incomplete BMP data')
    }

    let width
    let height
    if (infoHeaderSize >= 40) {
      width = contents.readInt32LE(18)
      height = contents.readInt32LE(22)
    } else if (infoHeaderSize >= 12) {
      width = contents.readUInt16LE(18)
      height = contents.readUInt16LE(20)
    } else {
      throw new Error('Unsupported BMP Information Header size')
    }

    const pixelDataOffset = contents.readUInt32LE(10)
    const pixelDataBuffer = contents.slice(pixelDataOffset)

    return { width, height, data: pixelDataBuffer }
  }

  getRecognizerModelName (langList) {
    const arabicLangList = ['ar', 'fa', 'ug', 'ur']
    const bengaliLangList = ['bn', 'as', 'mni']
    const cyrillicLangList = ['ru', 'rs_cyrillic', 'be', 'bg', 'uk', 'mn', 'abq', 'ady', 'kbd', 'ava', 'dar', 'inh', 'che',
      'lbe', 'lez', 'tab', 'tjk']
    const devanagariLangList = ['hi', 'mr', 'ne', 'bh', 'mai', 'ang', 'bho', 'mah', 'sck', 'new', 'gom', 'sa', 'bgc']

    const langMap = {
      th: 'thai',
      ch_tra: 'zh_tra',
      ch_sim: 'zh_sim',
      ja: 'japanese',
      ko: 'korean',
      ta: 'tamil',
      te: 'telugu',
      kn: 'kannada'
    }
    for (const [k, v] in langMap) {
      if (langList.includes(k)) return v
    }

    for (const lang of langList) {
      if (bengaliLangList.includes(lang)) {
        return 'bengali'
      }
      if (arabicLangList.includes(lang)) {
        return 'arabic'
      }
      if (devanagariLangList.includes(lang)) {
        return 'devanagari'
      }
      if (cyrillicLangList.includes(lang)) {
        return 'cyrillic'
      }
    }

    return 'latin'
  }
}

function dataAsString (data) {
  if (!data) return ''
  if (typeof data === 'object') {
    return JSON.stringify(data)
  }
  return data.toString()
}

module.exports = ONNXOcr
