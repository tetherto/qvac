'use strict'

const state = Object.freeze({
  LOADING: 'loading',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  IDLE: 'idle',
  STOPPED: 'stopped',
  PAUSED: 'paused'
})

const END_OF_INPUT = 'end of job'
const END_OF_OUTPUT = 'end of job'

class MockedBindings {
  constructor () {
    this.instance = null
  }

  createInstance (instance, configurationParams, outputCb, transitionCb = null) {
    this.instanceId = 1

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

  loadWeights (handle, weightsData) {
    if (handle !== this.instanceId) {
      throw new Error(`Invalid handle: ${handle}. Expected: ${this.instanceId}`)
    }

    console.log(`Loading weights for instance ${handle}: ${weightsData}`)
    // After creating the addon, we allow weights to be loaded. The loadWeights
    // method accepts chunks of data to be loaded while the addon is in the LOADING
    // status. A call to activate() will be required to move the addon to IDLE status.
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

  append (handle, data) {
    if (handle !== this.instanceId) {
      throw new Error(`Invalid handle: ${handle}. Expected: ${this.instanceId}`)
    }

    const { type, input, priority } = data
    const priorityStr = priority !== undefined ? ` with priority ${priority}` : ''
    console.log(`Instance ${handle}: New chunk of data is appended: ${input}, type: ${type}${priorityStr}`)

    // Process data only if the addon is in a receptive state.
    if (this.instance._state === state.LISTENING || this.instance._state === state.PROCESSING) {
      if (type === END_OF_INPUT) {
        // Capture the current job id for the callback.
        const currentJob = this.instance.jobId
        setImmediate(() => {
          // Emit a "job ended" event via the callback with the captured job id.
          this.instance.outputCb(this.instance, 'JobEnded', currentJob, { type: END_OF_OUTPUT }, null)
        })
        // Advance jobId for the next job.
        this.instance.jobId = currentJob + 1
        return currentJob
      } else if (type === 'text') {
        // Transition to PROCESSING.
        this.instance._state = state.PROCESSING
        if (this.instance.transitionCb) {
          this.instance.transitionCb(this.instance, this.instance._state)
        }
        const currentJob = this.instance.jobId
        setImmediate(() => {
          // Emit an output event with the length of the text.
          this.instance.outputCb(this.instance, 'Output', currentJob, { type: 'number', data: input.length }, null)
          // After processing, return to LISTENING state.
          this.instance._state = state.LISTENING
          if (this.instance.transitionCb) {
            this.instance.transitionCb(this.instance, this.instance._state)
          }
        })
        return currentJob
      } else {
        const currentJob = this.instance.jobId
        setImmediate(() => {
          this.instance.outputCb(this.instance, 'Error', currentJob, { error: `Unknown type: ${type}` }, null)
        })
        return currentJob
      }
    } else {
      // If not in a valid state, immediately emit an error.
      const currentJob = this.instance.jobId
      setImmediate(() => {
        this.instance.outputCb(this.instance, 'Error', currentJob, { error: 'Invalid state for appending data' }, null)
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

  destroyInstance (handle) {
    if (handle !== this.instanceId) {
      throw new Error(`Invalid handle: ${handle}. Expected: ${this.instanceId}`)
    }

    console.log(`Destroyed instance ${handle}`)
    this.instance = null
    this.instanceId = null
    // Clear resources on the C++ side.
  }

  /* additional methods to query state */
}

module.exports = MockedBindings
