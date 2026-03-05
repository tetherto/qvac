'use strict'

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle',
  PAUSED: 'paused',
  STOPPED: 'stopped'
})

class MockedBinding {
  constructor () {
    this._handle = null
    this._state = state.LOADING
    this._busy = false
    this._runToken = 0
    this._baseInferenceCallback = null
    this._interfaceType = null
  }

  createInstance (interfaceType, configurationParams, outputCb, transitionCb = null) {
    console.log('Constructing the parakeet addon')
    this._interfaceType = interfaceType
    this.outputCb = outputCb
    this.transitionCb = transitionCb
    this._handle = { id: Date.now() } // Create a mock handle
    return this._handle
  }

  setBaseInferenceCallback (callback) {
    this._baseInferenceCallback = callback
  }

  _callCallbacks (event, output, error = null) {
    if (this._baseInferenceCallback) {
      const jobId = this._interfaceType?._activeJobId
      const baseEvent = event === 'RuntimeStats' ? 'JobEnded' : event
      this._baseInferenceCallback(this, baseEvent, jobId, output, error)
    }

    if (this.outputCb) {
      this.outputCb(this, event, output, error)
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
    this._busy = false
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
    this._runToken++
    this._busy = false
    this._state = state.LISTENING
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  status (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    return this._state
  }

  runJob (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (this._busy) {
      return false
    }

    if (data.type !== 'audio' || !data.input) {
      process.nextTick(() => {
        this._callCallbacks('Error', undefined, `Invalid runJob payload type: ${data.type}`)
      })
      return true
    }

    this._busy = true
    this._state = state.PROCESSING
    if (this.transitionCb) this.transitionCb(this, this._state)

    const runToken = ++this._runToken
    process.nextTick(() => {
      if (runToken !== this._runToken) return

      const audioLength = data.input.length ?? (data.input.byteLength / 4)
      const mockTranscription = {
        text: audioLength > 0 ? `Mock transcription for ${audioLength} samples of audio` : '[No speech detected]',
        start: 0,
        end: audioLength / 16000,
        toAppend: true
      }

      this._callCallbacks('Output', [mockTranscription], null)
      this._callCallbacks('RuntimeStats', { totalTime: 0.001, audioDurationMs: Math.floor((audioLength / 16000) * 1000), totalSamples: audioLength }, null)
      this._busy = false
      this._state = state.LISTENING
      if (this.transitionCb) this.transitionCb(this, this._state)
    })

    return true
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
    this._runToken++
    this._busy = false
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
    this._runToken++
    this._busy = false
    this._handle = null
    console.log('Destroyed the addon')
    this._state = state.IDLE
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }
}

module.exports = MockedBinding
