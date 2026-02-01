'use strict'

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle',
  PAUSED: 'paused',
  STOPPED: 'stopped'
})

const END_OF_INPUT = 'end of job'
const END_OF_OUTPUT = 'end of job'

class MockedBinding {
  constructor () {
    this._handle = null
    this._state = state.LOADING
    this.jobId = 1
    this.isVadTest = false
    this._baseInferenceCallback = null // Store reference to BaseInference callback
  }

  enableVadTestMode () {
    this.isVadTest = true
  }

  createInstance (interfaceType, configurationParams, outputCb, transitionCb = null) {
    console.log('Constructing the whisper addon')
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
  _callCallbacks (event, jobId, output, error) {
    // Call the test's onOutput function
    if (this.outputCb) {
      this.outputCb(this, event, jobId, output, error)
    }

    // Call the BaseInference callback to resolve _finishPromise
    if (this._baseInferenceCallback) {
      this._baseInferenceCallback(this, event, jobId, output, error)
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

  pause (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Paused the processing')
    this._state = state.PAUSED
    // Interrupt the processing as soon as possible, but allow resuming.
    // When activate() is called, processing will resume from where it left off.
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  stop (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Stopped the processing')
    this._state = state.STOPPED
    // Discards the current job and stops processing. When activate() is called
    // again, it will start from the next job in the queue.
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  cancel (handle, jobId) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log(`Cancel job id: ${jobId}`)
    this._state = state.STOPPED
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
    // Cancels a specific job by ID. If the job is currently being processed,
    // it will be stopped. If the job is in the queue, it will be removed.
    // No effect if a finished job or non-existent id is passed.
  }

  status (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    return this._state
    // Returns whether the plugin status is LOADING, PROCESSING, LISTENING, IDLE,
    // STOPPED, or PAUSED
  }

  append (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    const currentJob = this.jobId

    // Only process if in a receptive state.
    if (this._state !== state.LISTENING && this._state !== state.PROCESSING && this._state !== state.IDLE) {
      process.nextTick(() => {
        this._callCallbacks('Error', currentJob, { error: 'Invalid state for appending data' }, null)
      })
      return currentJob
    }

    // If in IDLE state, transition to LISTENING when receiving new data
    if (this._state === state.IDLE) {
      this._state = state.LISTENING
      if (this.transitionCb) this.transitionCb(this, this._state)
    }

    if (data.type === END_OF_INPUT) {
      // End-of-job: emit a JobEnded event and increment job id.
      // Use process.nextTick to ensure this happens in the same tick as the append call
      process.nextTick(() => {
        this._callCallbacks('JobEnded', currentJob, { type: END_OF_OUTPUT }, null)
      })
      this.jobId++
      return currentJob
    } else if (data.type === 'audio') {
      if (!data.input || typeof data.input.length === 'undefined') {
        process.nextTick(() => {
          this._callCallbacks('Error', currentJob, { error: 'Invalid audio input: must be array-like with length property' }, null)
        })
        return currentJob
      }

      if (typeof data.input === 'string' || typeof data.input === 'number' || typeof data.input === 'boolean') {
        process.nextTick(() => {
          this._callCallbacks('Error', currentJob, { error: `Invalid audio input type: ${typeof data.input}. Expected array-like object.` }, null)
        })
        return currentJob
      }

      this._state = state.PROCESSING
      if (this.transitionCb) this.transitionCb(this, this._state)

      // Use process.nextTick to ensure proper event ordering
      process.nextTick(() => {
        if (this.isVadTest) {
          const mockTranscription = data.input.length > 0
            ? `Mock transcription for ${data.input.length} bytes of audio`
            : 'Silent audio detected'
          this._callCallbacks('Output', currentJob, mockTranscription, null)
        } else {
          this._callCallbacks('Output', currentJob, { data: data.input.length }, null)
        }
        // After processing, return to listening.
        this._state = state.LISTENING
        if (this.transitionCb) this.transitionCb(this, this._state)
      })
      return currentJob
    } else {
      // Unknown type: emit an error.
      process.nextTick(() => {
        this._callCallbacks('Error', currentJob, { error: `Unknown type: ${data.type}` }, null)
      })
      return currentJob
    }
  }

  load (handle, configurationParams) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Loaded configuration:', configurationParams)
    this._state = state.LOADING
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  reload (handle, configurationParams) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Reloaded configuration:', configurationParams)
    this._state = state.LOADING
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
    // After reload completes, transition back to IDLE to match C++ behavior
    process.nextTick(() => {
      this._state = state.IDLE
      if (this.transitionCb) {
        this.transitionCb(this, this._state)
      }
    })
  }

  unload (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Unloaded the addon')
    this._state = state.IDLE
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
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

  unloadWeights (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Unloaded weights')
    return true
  }

  destroyInstance (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._handle = null
    console.log('Destroyed the addon')
    // Clear resources on the C++ side.
    this._state = state.IDLE
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }
}

module.exports = MockedBinding
