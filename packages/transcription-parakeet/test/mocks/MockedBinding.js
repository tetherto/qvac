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
    this._interfaceType = null
    // Duplex streaming session state. Mirrors the C++ side's
    // g_streamingSessions map: at most one session per addon
    // instance, opened by `startStreaming` and torn down by
    // `endStreaming` / `cancel`. Each `appendStreamingAudio` call
    // synthesises one Output event so the wrapper's onUpdate fires
    // at the same cadence the real binding would.
    this._streamingActive = false
    this._streamingChunkIndex = 0
    this._streamingConfig = null
    // History of streaming actions for tests to assert against
    // (counts of starts / appends / ends / cancels, plus the
    // last streamingConfig that was passed). Reset implicitly via
    // `destroyInstance`.
    this._streamingLog = {
      starts: 0,
      appends: 0,
      ends: 0,
      cancels: 0,
      lastConfig: null
    }
  }

  createInstance (interfaceType, configurationParams, outputCb, transitionCb = null) {
    console.log('Constructing the parakeet addon (ggml backend)')
    this._interfaceType = interfaceType
    this._config = configurationParams
    this.outputCb = outputCb
    this.transitionCb = transitionCb
    this._handle = { id: Date.now() }
    return this._handle
  }

  _callCallbacks (event, output, error = null) {
    if (this.outputCb) {
      this.outputCb(this, event, output, error)
    }
  }

  loadWeights (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    // Real binding accepts a single GGUF byte stream (`{ filename,
    // chunk, completed }`). The mock just logs the filename to
    // confirm the right shape was passed.
    console.log(`Loading GGUF: ${data?.filename || '<inline>'}`)
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

  cancel (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    console.log('Cancel job')
    this._runToken++
    this._busy = false
    this._state = state.LISTENING
    if (this._streamingActive) {
      this._streamingActive = false
      this._streamingChunkIndex = 0
      this._streamingLog.cancels++
    }
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }

  // ─── Duplex streaming surface ─────────────────────────────────────────
  // Mirrors the AddonJs.hpp entry points (`startStreaming`,
  // `appendStreamingAudio`, `endStreaming`) plus the cancel-with-
  // streaming hook. Each appended chunk synthesises one Output event
  // so the wrapper's `onUpdate(...)` fires at the same cadence the
  // real binding would; endStreaming is intentionally side-effect-free
  // because the JS wrapper synthesises its own JobEnded (see
  // parakeet.js).
  startStreaming (handle, config = {}) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (this._streamingActive) {
      throw new Error('Streaming session already active for this instance')
    }
    this._streamingActive = true
    this._streamingChunkIndex = 0
    this._streamingConfig = config
    this._streamingLog.starts++
    this._streamingLog.lastConfig = config
    return true
  }

  appendStreamingAudio (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (!this._streamingActive) {
      throw new Error('No active streaming session for this instance')
    }
    if (data?.type !== 'audio' || !data?.input) {
      throw new Error(`Invalid appendStreamingAudio payload type: ${data?.type}`)
    }
    if (data.input.length === 0) return false
    this._streamingLog.appends++
    const chunkIndex = this._streamingChunkIndex++
    const audioLength = data.input.length
    const sampleRate = 16000
    const startS = (chunkIndex * audioLength) / sampleRate
    const endS = ((chunkIndex + 1) * audioLength) / sampleRate
    process.nextTick(() => {
      if (!this._streamingActive) return
      this._callCallbacks('Output', [{
        text: `Mock streaming chunk ${chunkIndex}`,
        start: startS,
        end: endS,
        toAppend: true,
        isEndOfTurn: false,
        startsWord: chunkIndex === 0
      }], null)
    })
    return true
  }

  endStreaming (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (!this._streamingActive) {
      return { cleaned: false, audioDurationMs: 0, totalSamples: 0 }
    }
    const samplesFed = this._streamingLog.appended *
      (this._streamingConfig?.sampleRate || 16000) *
      (this._streamingConfig?.chunkMs || 1000) / 1000
    this._streamingActive = false
    this._streamingChunkIndex = 0
    this._streamingConfig = null
    this._streamingLog.ends++
    return {
      cleaned: true,
      audioDurationMs: samplesFed > 0 ? samplesFed / 16 : 0,
      totalSamples: Math.round(samplesFed)
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
      // Mirror the realistic key set ParakeetModel::runtimeStats()
      // emits (see addon/src/model-interface/parakeet/ParakeetModel.cpp)
      // so tests inspecting stats see the GGUF-backend shape.
      const audioDurationMs = Math.floor((audioLength / 16000) * 1000)
      this._callCallbacks('RuntimeStats', {
        processCalls: 1,
        totalSamples: audioLength,
        totalTokens: 0,
        totalTranscriptions: 1,
        totalWallMs: 1,
        totalTime: 1,
        modelLoadMs: 0,
        encoderMs: 1,
        decoderMs: 0,
        melSpecMs: 0,
        totalEncodedFrames: 0,
        audioDurationMs,
        backendDevice: 0,
        backendId: 0
      }, null)
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
    this._streamingActive = false
    this._streamingChunkIndex = 0
    this._streamingConfig = null
    console.log('Destroyed the addon')
    this._state = state.IDLE
    if (this.transitionCb) {
      this.transitionCb(this, this._state)
    }
  }
}

module.exports = MockedBinding
