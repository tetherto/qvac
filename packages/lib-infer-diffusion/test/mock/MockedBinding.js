'use strict'

const MINIMAL_PNG = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 pixel
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8-bit RGB + CRC
  0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT length + type
  0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, // compressed data
  0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, // CRC
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND length + type
  0x44, 0xAE, 0x42, 0x60, 0x82                     // IEND CRC
])

class MockedBinding {
  constructor () {
    this._handle = null
    this._jsHandle = null
    this._outputCb = null
    this._cancelled = false
    this._running = false
  }

  createInstance (jsHandle, configurationParams, outputCb) {
    this._jsHandle = jsHandle
    this._outputCb = outputCb
    this._handle = { id: Date.now() }
    return this._handle
  }

  activate (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
  }

  runJob (handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    if (this._running) return false

    this._running = true
    this._cancelled = false

    let params = {}
    if (data && data.type === 'text' && data.input) {
      try { params = JSON.parse(data.input) } catch (_) {}
    }

    const steps = params.steps || 20
    const batchCount = params.batch_count || 1
    let currentStep = 0

    const emitNextStep = () => {
      if (this._cancelled || !this._running) return

      currentStep++
      if (currentStep <= steps) {
        const tick = JSON.stringify({
          step: currentStep,
          total: steps,
          elapsed_ms: currentStep * 50
        })
        this._outputCb(this._jsHandle, 'Output', tick, null)
        setTimeout(emitNextStep, 1)
      } else {
        for (let i = 0; i < batchCount; i++) {
          this._outputCb(this._jsHandle, 'Output', new Uint8Array(MINIMAL_PNG), null)
        }
        this._outputCb(this._jsHandle, 'JobEnded', {
          generation_time: steps * 50,
          seed: params.seed != null ? params.seed : 42
        }, null)
        this._running = false
      }
    }

    setTimeout(emitNextStep, 5)
    return true
  }

  cancel (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._cancelled = true
    if (this._running) {
      this._running = false
      this._outputCb(this._jsHandle, 'JobEnded', {
        generation_time: 0,
        cancelled: true
      }, null)
    }
  }

  unloadModel (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
  }

  destroyInstance (handle) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this._handle = null
    this._jsHandle = null
    this._outputCb = null
    this._running = false
  }

  setLogger () {}
  releaseLogger () {}
}

module.exports = MockedBinding
