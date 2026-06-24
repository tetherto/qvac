'use strict'

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle'
})

class MockedBinding {
  constructor ({ jobDelayMs = 10 } = {}) {
    this._handle = null
    this._state = state.LOADING
    this.outputCb = null
    this._baseInferenceCallback = null
    this._cancelRequested = false
    this._jobDelayMs = jobDelayMs
    this.lastCreatedConfiguration = null
    this.lastRunJob = null
  }

  createInstance (interfaceType, configurationParams, outputCb) {
    console.log('Constructing the TTS addon')
    this.outputCb = outputCb
    this._handle = { id: Date.now() }
    this.lastCreatedConfiguration = configurationParams
    return this._handle
  }

  setBaseInferenceCallback (callback) {
    this._baseInferenceCallback = callback
  }

  _callCallbacks (event, data, error) {
    // addon-cpp 1.1.5 emits event, data, error only; job ownership stays in JS.
    if (this.outputCb) {
      this.outputCb(this, event, data, error)
    }
    if (this._baseInferenceCallback) {
      this._baseInferenceCallback(this, event, data, error)
    }
  }

  activate (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Activated the TTS addon')
    this._state = state.LISTENING
  }

  cancel (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._cancelRequested = true
  }

  runJob (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')

    if (this._state !== state.LISTENING) {
      throw new Error('TTS addon is not accepting jobs (not in listening state)')
    }

    if (!data || data.type !== 'text' || typeof data.input !== 'string') {
      throw new TypeError('runJob(data) expects { type: "text", input: string }')
    }

    this.lastRunJob = data
    this._state = state.PROCESSING
    this._cancelRequested = false

    setTimeout(() => {
      if (this._cancelRequested) {
        this._callCallbacks('Error', null, 'Job cancelled')
        this._state = state.LISTENING
        return
      }

      const sampleCount = data.input.length * 100
      const mockAudioSamples = new Int16Array(sampleCount)
      for (let i = 0; i < sampleCount; i++) {
        mockAudioSamples[i] = Math.floor(Math.sin(i * 0.1) * 10000)
      }

      this._callCallbacks('AudioResult', { outputArray: mockAudioSamples }, null)
      this._callCallbacks('RuntimeStats', {
        totalTime: 0.12,
        tokensPerSecond: 120,
        realTimeFactor: 0.08,
        audioDurationMs: sampleCount / 24,
        totalSamples: sampleCount
      }, null)
      this._state = state.LISTENING
    }, this._jobDelayMs)
    return true
  }

  loadWeights (handle, weightsData) {
    if (handle !== this._handle) throw new Error('Invalid handle')
  }

  destroyInstance (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._handle = null
    this._state = state.IDLE
  }

  unload (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this.destroyInstance(handle)
  }

  status () {
    return this._state
  }

  pause () {
    throw new Error('pause() is not supported in addon-cpp 1.x')
  }

  stop () {
    throw new Error('stop() is not supported in addon-cpp 1.x')
  }

  load () {
    throw new Error('load() is not supported in addon-cpp 1.x')
  }

  reload () {
    throw new Error('reload() is not supported in addon-cpp 1.x')
  }

  append () {
    throw new Error('append() is not supported in addon-cpp 1.x')
  }

  unloadWeights () {
    throw new Error('unloadWeights() is not supported in addon-cpp 1.x')
  }

  set transitionCb (_) {
    // no-op in addon-cpp 1.x mock
  }

  get transitionCb () {
    return null
  }

  get state () {
    return this._state
  }

  set state (nextState) {
    if (Object.values(state).includes(nextState)) {
      this._state = nextState
    }
  }
}

module.exports = MockedBinding
