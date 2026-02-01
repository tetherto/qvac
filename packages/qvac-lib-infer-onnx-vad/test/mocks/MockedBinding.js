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
    this.instance = null
    this.instanceId = null
  }

  createInstance (instance, configurationParams, outputCb, transitionCb = null) {
    this.instanceId = Date.now()

    this.instance = {
      id: this.instanceId,
      _state: state.LOADING,
      outputCb,
      transitionCb,
      jobId: 1,
      configurationParams
    }

    console.log(`Created mock instance ${this.instanceId}`)
    return this.instanceId
  }

  activate (handle) {
    if (handle !== this.instanceId) {
      throw new Error(`Invalid handle: ${handle}. Expected: ${this.instanceId}`)
    }

    console.log(`Activated instance ${handle}`)
    this.instance._state = state.LISTENING
    if (this.instance.transitionCb) {
      this.instance.transitionCb(this.instance, this.instance._state)
    }
  }

  pause (handle) {
    if (handle !== this.instanceId) {
      throw new Error(`Invalid handle: ${handle}. Expected: ${this.instanceId}`)
    }

    console.log(`Paused instance ${handle}`)
    this.instance._state = state.PAUSED
    if (this.instance.transitionCb) {
      this.instance.transitionCb(this.instance, this.instance._state)
    }
  }

  stop (handle) {
    if (handle !== this.instanceId) {
      throw new Error(`Invalid handle: ${handle}. Expected: ${this.instanceId}`)
    }

    console.log(`Stopped instance ${handle}`)
    this.instance._state = state.STOPPED
    if (this.instance.transitionCb) {
      this.instance.transitionCb(this.instance, this.instance._state)
    }
  }

  cancel (handle, jobId) {
    if (handle !== this.instanceId) {
      throw new Error(`Invalid handle: ${handle}. Expected: ${this.instanceId}`)
    }

    console.log(`Cancel job ${jobId} for instance ${handle}`)
    this.instance._state = state.STOPPED
    if (this.instance.transitionCb) {
      this.instance.transitionCb(this.instance, this.instance._state)
    }
  }

  append (handle, data) {
    if (handle !== this.instanceId) {
      throw new Error(`Invalid handle: ${handle}. Expected: ${this.instanceId}`)
    }

    const { type, input } = data
    const currentJob = this.instance.jobId

    // Only process if in a receptive state.
    if (this.instance._state !== state.LISTENING && this.instance._state !== state.PROCESSING) {
      setImmediate(() => {
        if (this.instance.outputCb) {
          this.instance.outputCb(this.instance, 'Error', currentJob, { error: 'Invalid state for appending data' }, null)
        }
      })
      return currentJob
    }

    if (type === END_OF_INPUT) {
      // End-of-job: emit a JobEnded event and increment job id.
      setImmediate(() => {
        if (this.instance.outputCb) {
          this.instance.outputCb(this.instance, 'JobEnded', currentJob, { type: END_OF_OUTPUT }, null)
        }
      })
      this.instance.jobId++
      return currentJob
    } else if (type === 'arrayBuffer') {
      // Process audio: simulate by returning the length of the audio chunk.
      this.instance._state = state.PROCESSING
      if (this.instance.transitionCb) this.instance.transitionCb(this.instance, this.instance._state)
      setImmediate(() => {
        if (this.instance.outputCb) {
          console.log('outputCb', input, type)
          this.instance.outputCb(this.instance, 'Output', currentJob, { data: input.byteLength }, null)
        }
        // After processing, return to listening.
        this.instance._state = state.LISTENING
        if (this.instance.transitionCb) this.instance.transitionCb(this.instance, this.instance._state)
      })
      return currentJob
    } else {
      // Unknown type: emit an error.
      setImmediate(() => {
        if (this.instance.outputCb) {
          this.instance.outputCb(this.instance, 'Error', currentJob, { error: `Unknown type: ${type}` }, null)
        }
      })
      return currentJob
    }
  }

  status (handle) {
    if (handle !== this.instanceId) {
      throw new Error(`Invalid handle: ${handle}. Expected: ${this.instanceId}`)
    }
    if (!this.instance) {
      return state.IDLE
    }

    return this.instance._state
  }

  destroyInstance (handle) {
    if (handle !== this.instanceId) {
      throw new Error(`Invalid handle: ${handle}. Expected: ${this.instanceId}`)
    }

    console.log(`Destroyed instance ${handle}`)
    this.instance = null
    this.instanceId = null
  }
}

module.exports = MockedBinding
