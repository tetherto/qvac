'use strict'

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle'
})

class MockedBinding {
  constructor () {
    this._handle = null
    this._state = state.LOADING
    this.isVadTest = false
    this._busy = false
    this._jobDelayMs = 0
    this._scriptedOutputs = null
    this._runToken = 0
    this._baseInferenceCallback = null // Store reference to BaseInference callback
    this._nextJobId = 1
    this._currentJobId = null
    this._streaming = false
    this._streamingChunks = []
    this._streamingErrorOnSegment = -1
  }

  enableVadTestMode () {
    this.isVadTest = true
  }

  setScriptedOutputs (outputs) {
    this._scriptedOutputs = Array.isArray(outputs) ? outputs : null
  }

  setJobDelayMs (delayMs) {
    this._jobDelayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0
  }

  setStreamingErrorOnSegment (segmentIndex) {
    this._streamingErrorOnSegment = segmentIndex
  }

  createInstance (interfaceType, configurationParams, outputCb, transitionCb = null) {
    console.log('Constructing the whisper addon')
    this._interfaceType = interfaceType
    this.outputCb = outputCb
    this.transitionCb = transitionCb
    this._handle = { id: Date.now() } // Create a mock handle
    return this._handle
  }

  // Mock only: Method to set the BaseInference callback to call in addition to custom outputCb
  setBaseInferenceCallback (callback) {
    this._baseInferenceCallback = callback
  }

  // Helper method to call both callbacks
  _callCallbacks (event, output, error, jobId = this._currentJobId) {
    // Call the test's onOutput function
    if (this.outputCb) {
      this.outputCb(this._interfaceType, event, output, error, jobId)
    }

    // Call the BaseInference callback to resolve _finishPromise
    if (this._baseInferenceCallback) {
      this._baseInferenceCallback(this._interfaceType, event, jobId, output, error)
    }
  }

  loadWeights (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log(`Loading weights: ${data.filename || data}`)
    // After creating the addon, we allow weights to be loaded. The loadWeights
    // method accepts chunks of data to be loaded while the addon is in the LOADING
    // status. A call to activate() will be required to move the addon to IDLE status.
    return true
  }

  activate (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Activated the addon')
    this._state = state.LISTENING
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
    // Activates the addon to start processing the queue. When activate() is called,
    // the addon will start processing the next job in the queue. If the addon is
    // stopped, it will start from the next job.
    // Calling activate() on an already active plugin has no effect
    // Will be in PROCESSING status while new job data is processed
    // Will be in LISTENING status while waiting for 'end of job' value
    // Will be in IDLE status while waiting for next job
  }

  reload (handle, configurationParams) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._configurationParams = configurationParams
    this._state = state.LOADING
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  cancel (handle, jobId) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log(`Cancel job id: ${jobId}`)
    this._runToken += 1
    this._busy = false
    this._currentJobId = null
    this._streaming = false
    this._streamingChunks = []
    this._state = state.LISTENING
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  status (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    return this._state
    // Returns whether the plugin status is LOADING, PROCESSING, LISTENING, IDLE,
    // STOPPED, or PAUSED
  }

  runJob (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (this._busy) {
      return false
    }
    const runToken = ++this._runToken
    const jobId = this._nextJobId++
    this._busy = true
    this._currentJobId = jobId
    this._state = state.PROCESSING
    if (this.transitionCb) this.transitionCb(this, this._state)

    const emitResults = () => {
      if (!this._busy || runToken !== this._runToken) {
        return
      }

      if (this._scriptedOutputs && this._scriptedOutputs.length > 0) {
        for (const output of this._scriptedOutputs) {
          this._callCallbacks('Output', output, null, jobId)
        }
      } else if (this.isVadTest) {
        const mockTranscription = data.input.length > 0
          ? { text: `Mock transcription for ${data.input.length} bytes of audio`, toAppend: false, start: 0, end: 1, id: 0 }
          : { text: 'Silent audio detected', toAppend: false, start: 0, end: 1, id: 0 }
        this._callCallbacks('Output', mockTranscription, null, jobId)
      } else {
        this._callCallbacks('Output', { data: data.input.length }, null, jobId)
      }

      if (!this._busy || runToken !== this._runToken) {
        return
      }
      this._callCallbacks('JobEnded', { totalTime: 0.01, audioDurationMs: data.input.length, totalSamples: data.input.length }, null, jobId)
      this._busy = false
      this._currentJobId = null
      this._state = state.LISTENING
      if (this.transitionCb) this.transitionCb(this, this._state)
    }

    if (this._jobDelayMs > 0) {
      setTimeout(emitResults, this._jobDelayMs)
    } else {
      process.nextTick(emitResults)
    }
    return true
  }

  append (handle, data) {
    // Legacy API for compatibility in older tests.
    if (data.type !== 'audio') {
      return 1
    }
    return this.runJob(handle, data) ? 1 : 0
  }

  setLogger (handle, logger) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Set logger:', logger)
    // Mock implementation - just log that it was called
  }

  releaseLogger (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Released logger')
    // Mock implementation - just log that it was called
  }

  startStreaming (handle, config) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (this._streaming) throw new Error('Streaming session already active')
    // Match WhisperInterface.startStreaming: allocate job id before native work so
    // _addonOutputCallback receives a finite nativeJobId for streaming events.
    const jobId = this._nextJobId
    this._nextJobId += 1
    this._currentJobId = jobId
    this._streaming = true
    this._streamingChunks = []
    this._busy = true
    this._state = state.PROCESSING
    if (this.transitionCb) this.transitionCb(this, this._state)
  }

  appendStreamingAudio (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (!this._streaming) throw new Error('No active streaming session')
    this._streamingChunks.push(data)
  }

  endStreaming (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (!this._streaming) return false
    this._streaming = false
    this._busy = false

    const chunks = this._streamingChunks
    this._streamingChunks = []

    const emitStreamResults = () => {
      const hasError = this._streamingErrorOnSegment >= 0 &&
        this._scriptedOutputs &&
        this._streamingErrorOnSegment < this._scriptedOutputs.length

      if (this._scriptedOutputs && this._scriptedOutputs.length > 0) {
        for (let i = 0; i < this._scriptedOutputs.length; i++) {
          if (i === this._streamingErrorOnSegment) continue
          this._callCallbacks('Output', this._scriptedOutputs[i], null)
        }
      }

      if (hasError) {
        this._callCallbacks('Error', null, new Error('One or more segments failed during processing'))
      } else {
        const totalSamples = chunks.reduce((sum, c) => sum + (c.input?.length || 0), 0)
        this._callCallbacks('JobEnded', {
          totalTime: 0.01 * Math.max(1, chunks.length),
          audioDurationMs: totalSamples,
          totalSamples,
          processCalls: chunks.length
        }, null)
      }

      this._currentJobId = null
      this._state = state.LISTENING
      if (this.transitionCb) this.transitionCb(this, this._state)
    }

    process.nextTick(emitStreamResults)
    return true
  }

  destroyInstance (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._runToken += 1
    this._busy = false
    this._currentJobId = null
    this._streaming = false
    this._streamingChunks = []
    this._handle = null
    console.log('Destroyed the addon')
    this._state = state.IDLE
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }
}

module.exports = MockedBinding
