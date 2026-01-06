'use strict'

const { InferenceArgsSchema } = require('../validation')
const { WhisperInterface } = require('../../../../whisper')
const fs = require('bare-fs')

class ProcessingQueue {
  constructor (maxActive = 5) {
    this.queue = []
    this.pendingPromises = new Set()
    this.active = 0
    this.maxActive = maxActive
  }

  async add (job) {
    if (this.active >= this.maxActive) {
      await new Promise(resolve => {
        this.queue.push(resolve)
      })
    }

    this.active++
    const promise = Promise.resolve().then(() => job())
    this.pendingPromises.add(promise)

    const cleanup = () => {
      this.pendingPromises.delete(promise)
      this.active--

      const next = this.queue.shift()
      if (next) { next() }
    }

    promise.then(cleanup, cleanup)
    return promise
  }

  async awaitForCompletion () {
    await Promise.allSettled([...this.pendingPromises])
    this.queue = []
  }
}

class WhisperBenchmarkRunner {
  constructor (payload, active) {
    this.payload = payload
    this.outputs = []
    this.transcriptionSegments = []
    this.whisperVersion = '1.0.0' // TODO: Get from somewhere
    this.startTime = Date.now()
    this.loadModelMs = 0
    this.processingQueue = new ProcessingQueue()
  }

  async run () {
    if (this.validateParams()) {
      const whisperParams = this.buildWhisperParams()
      await this.processAudio(whisperParams)
    } else {
      throw new Error('Invalid params')
    }
  }

  validateParams () {
    try {
      InferenceArgsSchema.parse(this.payload)
      return true
    } catch {
      return false
    }
  }

  buildWhisperParams () {
    return {
      opts: { stats: true },
      path: this.payload.config.path,
      whisperConfig: this.payload.config.whisperConfig
    }
  }

  async processAudio (whisperParams) {
    const onOutput = (addon, event, jobId, output, error) => {
      if (event === 'Output') {
        if (output && Array.isArray(output)) {
          console.log('Transcription output:', output)
          this.transcriptionSegments.push(...output)
        }
      } else if (event === 'Error' && error) {
        console.error('Error from Whisper:', error)
      }
    }

    console.log('Whisper Params:', whisperParams)
    const model = new WhisperInterface(whisperParams, onOutput)
    await model.activate()
    await this.processAllFiles(model)
    await model.destroy()
  }

  async transcribeAudio (model, audioData) {
    await model.append({ type: 'audio', input: new Uint8Array(audioData) })
    await model.append({ type: 'end of job' })

    await this.waitForCompletion(model)

    this.saveTranscriptionResults()
  }

  saveTranscriptionResults () {
    const transcription = this.transcriptionSegments
      .map(segment => segment.text)
      .join(' ')
      .trim()

    this.outputs.push(transcription)
  }

  async processAllFiles (model) {
    const processFile = async (audioFilePath) => {
      try {
        this.transcriptionSegments = []
        const audioData = await fs.promises.readFile(audioFilePath)
        await this.transcribeAudio(model, audioData)

        return { file: audioFilePath, success: true }
      } catch (error) {
        this.errors.push({ file: audioFilePath, error: error.message })
        return { file: audioFilePath, success: false, error: error.message }
      }
    }

    for (const audioFilePath of this.payload.inputs) {
      await this.processingQueue.add(() => processFile(audioFilePath))
    }
  }

  async waitForCompletion (model) {
    while (true) {
      const status = await model.status()
      if (status === 'IDLE') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  getResult () {
    const endTime = Date.now()
    const runMs = endTime - this.startTime - this.loadModelMs

    return {
      outputs: this.outputs,
      whisperVersion: this.whisperVersion,
      time: {
        loadModelMs: this.loadModelMs,
        runMs
      }
    }
  }
}

module.exports = {
  WhisperBenchmarkRunner
}
