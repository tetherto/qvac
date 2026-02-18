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
    this._baseInferenceCallback = null // Store reference to BaseInference callback
  }

  createInstance (interfaceType, configurationParams, outputCb, transitionCb = null) {
    console.log('Constructing the parakeet addon')
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
    return true
  }

  activate (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Activated the addon')
    this._state = state.LISTENING
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  pause (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Paused the processing')
    this._state = state.PAUSED
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  stop (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Stopped the processing')
    this._state = state.STOPPED
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
  }

  status (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    return this._state
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
      process.nextTick(() => {
        this._callCallbacks('JobEnded', currentJob, { type: END_OF_OUTPUT }, null)
      })
      this.jobId++
      return currentJob
    } else if (data.type === 'audio') {
      // Validate audio data
      if (!data.data) {
        process.nextTick(() => {
          this._callCallbacks('Error', currentJob, { error: 'Invalid audio input: missing data property' }, null)
        })
        return currentJob
      }

      this._state = state.PROCESSING
      if (this.transitionCb) this.transitionCb(this, this._state)

      // Simulate transcription output
      process.nextTick(() => {
        const audioSize = data.data.byteLength || 0
        const mockTranscription = {
          text: audioSize > 0 ? `Mock transcription for ${audioSize} bytes of audio` : '[No speech detected]',
          start: 0,
          end: audioSize / 16000 / 4, // Approximate duration in seconds (float32 @ 16kHz)
          toAppend: true
        }
        this._callCallbacks('Output', currentJob, [mockTranscription], null)
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

  setLogger (callback) {
    console.log('Set logger')
  }

  releaseLogger () {
    console.log('Released logger')
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
    this._state = state.IDLE
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }
}

module.exports = MockedBinding
