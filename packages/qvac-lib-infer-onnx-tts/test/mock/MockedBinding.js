'use strict'

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  UNLOADED: 'unloaded'
})

const END_OF_INPUT = 'end of job'
const END_OF_OUTPUT = 'end of job'

class MockedBinding {
  constructor () {
    this._handle = null
    this._state = state.LOADING
    this.jobId = 1
    this.outputCb = null
    this.transitionCb = null
    this._baseInferenceCallback = null
  }

  createInstance (interfaceType, configurationParams, outputCb, transitionCb = null) {
    console.log('Constructing the TTS addon')
    this.outputCb = outputCb
    this.transitionCb = transitionCb
    this._handle = { id: Date.now() }
    return this._handle
  }

  setBaseInferenceCallback (callback) {
    this._baseInferenceCallback = callback
  }

  _callCallbacks (event, jobId, output, error) {
    if (this.outputCb) {
      this.outputCb(this, event, jobId, output, error)
    }
    if (this._baseInferenceCallback) {
      this._baseInferenceCallback(this, event, jobId, output, error)
    }
  }

  activate (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Activated the TTS addon')
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

    if (this._state !== state.LISTENING && this._state !== state.PROCESSING && this._state !== state.IDLE) {
      process.nextTick(() => {
        this._callCallbacks('Error', currentJob, { error: 'Invalid state for appending data' }, null)
      })
      return currentJob
    }

    if (this._state === state.IDLE) {
      this._state = state.LISTENING
      if (this.transitionCb) this.transitionCb(this, this._state)
    }

    if (data.type === END_OF_INPUT) {
      process.nextTick(() => {
        this._callCallbacks('JobEnded', currentJob, { type: END_OF_OUTPUT }, null)
      })
      this.jobId++
      return currentJob
    } else if (data.type === 'text') {
      if (!data.input || typeof data.input !== 'string') {
        process.nextTick(() => {
          this._callCallbacks('Error', currentJob, { error: 'Invalid text input: must be a non-empty string' }, null)
        })
        return currentJob
      }

      this._state = state.PROCESSING
      if (this.transitionCb) this.transitionCb(this, this._state)

      process.nextTick(() => {
        // Generate mock audio samples (Int16 values)
        // Simulate ~100 samples per character at 16kHz
        const sampleCount = data.input.length * 100
        const mockAudioSamples = new Int16Array(sampleCount)
        for (let i = 0; i < sampleCount; i++) {
          // Generate a simple sine wave pattern for mock audio
          mockAudioSamples[i] = Math.floor(Math.sin(i * 0.1) * 10000)
        }

        this._callCallbacks('Output', currentJob, { outputArray: mockAudioSamples }, null)

        this._state = state.LISTENING
        if (this.transitionCb) this.transitionCb(this, this._state)
      })
      return currentJob
    } else {
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
    this._state = state.UNLOADED
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  destroyInstance (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._handle = null
    console.log('Destroyed the TTS addon')
    this._state = state.IDLE
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }
}

module.exports = MockedBinding
