'use strict'

const AddonInterface = require('./MockAddon')
const { createJobHandler } = require('@qvac/infer-base')
const fs = require('bare-fs')
const { transitionCb } = require('./utils.js')

const END_OF_INPUT = 'end of job'

class ONNXOcr {
  constructor (args) {
    this.args = args
    this.addon = null
    this._job = createJobHandler({ cancel: () => this.addon.cancel() })
  }

  async load () {
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
    if (event === 'Error') {
      this._job.fail(error)
    } else if (event === 'Output') {
      this._job.output(data)
    } else if (event === 'JobEnded') {
      this._job.end(this.opts?.stats ? data : null)
    }
  }

  async _runInternal (input) {
    const imageInput = this.getImage(input.path)
    await this.addon.append({ type: 'image', input: imageInput, options: input.options })
    const response = this._job.start()
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
    for (const [k, v] of Object.entries(langMap)) {
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

module.exports = ONNXOcr
