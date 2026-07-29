'use strict'

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle'
})

// Mirrors the whisper arm of the merged asr-ggml native binding
// (addon/src/addon/AddonJs.hpp): `createInstance` reads the unified
// `configurationParams.engineType` dispatch key, `getBackendInfo` returns the
// six cross-engine keys plus the whisper-only GPU-memory extras, and
// `endStreaming` returns the parakeet-shaped teardown object
// ({ cleaned, audioDurationMs, totalSamples }).
class MockedBinding {
  constructor() {
    this._handle = null
    this._state = state.LOADING
    this.isVadTest = false
    this._busy = false
    this._jobDelayMs = 0
    this._scriptedOutputs = null
    this._runToken = 0
    this._nextJobId = 1
    this._currentJobId = null
    this._streaming = false
    this._streamingChunks = []
    this._streamingErrorOnSegment = -1
    this.lastStreamingConfig = null
    this.engineType = null
  }

  enableVadTestMode() {
    this.isVadTest = true
  }

  setScriptedOutputs(outputs) {
    this._scriptedOutputs = Array.isArray(outputs) ? outputs : null
  }

  setJobDelayMs(delayMs) {
    this._jobDelayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0
  }

  setStreamingErrorOnSegment(segmentIndex) {
    this._streamingErrorOnSegment = segmentIndex
  }

  createInstance(interfaceType, configurationParams, outputCb, transitionCb = null) {
    console.log('Constructing the asr-ggml addon (whisper engine)')
    // Mirror JSAdapter::readEngineType: an unknown non-empty engineType is a
    // hard error; absent/empty falls through to inference (default whisper).
    const engineType = configurationParams?.engineType
    if (
      typeof engineType === 'string' &&
      engineType.length > 0 &&
      engineType !== 'whisper' &&
      engineType !== 'parakeet'
    ) {
      throw new Error(`engineType must be 'whisper' or 'parakeet' (got '${engineType}')`)
    }
    this.engineType = engineType || 'whisper'
    this._interfaceType = interfaceType
    this._configurationParams = configurationParams
    this.outputCb = outputCb
    this.transitionCb = transitionCb
    this._handle = { id: Date.now() } // Create a mock handle
    return this._handle
  }

  // Legacy no-op kept so older tests can still call it.
  setBaseInferenceCallback(callback) {
    this._baseInferenceCallback = callback
  }

  // Mimic addon-cpp 1.1.5 callback shape: no trailing native job id.
  _callCallbacks(event, output, error) {
    if (this.outputCb) {
      this.outputCb(this._interfaceType, event, output, error)
    }
  }

  loadWeights(handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log(`Loading weights: ${data.filename || data}`)
    // After creating the addon, we allow weights to be loaded. The loadWeights
    // method accepts chunks of data to be loaded while the addon is in the LOADING
    // status. A call to activate() will be required to move the addon to IDLE status.
    return true
  }

  activate(handle) {
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

  reload(handle, configurationParams) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._configurationParams = configurationParams
    this._state = state.LOADING
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  // Mirror the whisper arm of the merged getBackendInfo verb: the six
  // cross-engine keys plus the whisper-only GPU-memory extras (-1 = the
  // device does not report, matching runtimeStats()).
  getBackendInfo(handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    return {
      backendDevice: 'CPU',
      backendId: 0,
      backendName: 'CPU',
      backendDescription: '',
      encoderBackend: 'CPU',
      encoderOnCoreml: false,
      gpuMemTotalMb: -1,
      gpuMemFreeMb: -1
    }
  }

  cancel(handle, jobId) {
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

  status(handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    return this._state
    // Returns whether the plugin status is LOADING, PROCESSING, LISTENING, IDLE,
    // STOPPED, or PAUSED
  }

  runJob(handle, data) {
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
        const mockTranscription =
          data.input.length > 0
            ? {
                text: `Mock transcription for ${data.input.length} bytes of audio`,
                toAppend: false,
                start: 0,
                end: 1,
                id: 0
              }
            : { text: 'Silent audio detected', toAppend: false, start: 0, end: 1, id: 0 }
        this._callCallbacks('Output', mockTranscription, null, jobId)
      } else {
        this._callCallbacks('Output', { data: data.input.length }, null, jobId)
      }

      if (!this._busy || runToken !== this._runToken) {
        return
      }
      this._callCallbacks(
        'JobEnded',
        { totalTime: 0.01, audioDurationMs: data.input.length, totalSamples: data.input.length },
        null,
        jobId
      )
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

  setLogger(handle, logger) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Set logger:', logger)
    // Mock implementation - just log that it was called
  }

  releaseLogger(handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Released logger')
    // Mock implementation - just log that it was called
  }

  startStreaming(handle, config) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (this._streaming) throw new Error('Streaming session already active for this instance')
    this.lastStreamingConfig = config
    // Match WhisperInterface.startStreaming: reserve the logical job slot before
    // native work begins so JS-owned ids stay aligned in tests.
    const jobId = this._nextJobId
    this._nextJobId += 1
    this._currentJobId = jobId
    this._streaming = true
    this._streamingChunks = []
    this._busy = true
    this._state = state.PROCESSING
    if (this.transitionCb) this.transitionCb(this, this._state)
  }

  // Unified merged-binding return: boolean back-pressure signal — `false` iff
  // the decoded sample count was 0, else `true`; throws with no session.
  appendStreamingAudio(handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (!this._streaming) throw new Error('No active streaming session for this instance')
    if (!data?.input || data.input.length === 0) return false
    this._streamingChunks.push(data)
    return true
  }

  // Unified merged-binding return: the parakeet-shaped teardown object.
  // Result events (Output/JobEnded/Error) still arrive through the output
  // callback, exactly like the native whisper StreamingProcessor.
  endStreaming(handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (!this._streaming) {
      return { cleaned: false, audioDurationMs: 0, totalSamples: 0 }
    }
    this._streaming = false
    this._busy = false

    const chunks = this._streamingChunks
    this._streamingChunks = []

    const totalBytes = chunks.reduce((sum, c) => sum + (c.input?.length || 0), 0)
    // The whisper driver pins the wire format to f32le: four bytes per sample.
    const totalSamples = Math.floor(totalBytes / 4)

    const emitStreamResults = () => {
      const hasError =
        this._streamingErrorOnSegment >= 0 &&
        this._scriptedOutputs &&
        this._streamingErrorOnSegment < this._scriptedOutputs.length

      if (this._scriptedOutputs && this._scriptedOutputs.length > 0) {
        for (let i = 0; i < this._scriptedOutputs.length; i++) {
          if (i === this._streamingErrorOnSegment) continue
          this._callCallbacks('Output', this._scriptedOutputs[i], null)
        }
      }

      if (hasError) {
        this._callCallbacks(
          'Error',
          null,
          new Error('One or more segments failed during processing')
        )
      } else {
        this._callCallbacks(
          'JobEnded',
          {
            totalTime: 0.01 * Math.max(1, chunks.length),
            audioDurationMs: totalBytes,
            totalSamples: totalBytes,
            processCalls: chunks.length
          },
          null
        )
      }

      this._currentJobId = null
      this._state = state.LISTENING
      if (this.transitionCb) this.transitionCb(this, this._state)
    }

    process.nextTick(emitStreamResults)
    return {
      cleaned: true,
      audioDurationMs: (totalSamples / 16000) * 1000,
      totalSamples
    }
  }

  destroyInstance(handle) {
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
