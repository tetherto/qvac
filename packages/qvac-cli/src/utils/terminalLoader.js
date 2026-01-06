'use strict'

const process = require('process')
const ansiEscapes = require('bare-ansi-escapes')

class TerminalLoader {
  static instance = null

  _isConsolePatched = false
  _hardStop = false
  _origConsole = {}

  _consoleQueue = []
  _consoleTimeout = null

  ioTimeoutMS = 100

  constructor () {
    if (TerminalLoader.instance) return TerminalLoader.instance

    this.isSpinning = false
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    this.frameIndex = 0
    this.interval = null

    // ensure instance of loader accessible from other parts of the code
    TerminalLoader.instance = this
  }

  start (text = this.text) {
    if (this.isSpinning) return

    this.text = text
    this._hardStop = false

    process.stdout.write(ansiEscapes.cursorHide)

    if (!this._isConsolePatched) this._patchConsole()

    this._runSpinner()
  }

  succeed (text = this.text) {
    this.stop()
    this._logWithDelayAndClearLastFrame(`✓ ${text}`)
  }

  fail (text = this.text) {
    this.stop()
    this._logWithDelayAndClearLastFrame(`✖ ${text}`)
  }

  warn (text = this.text) {
    this.stop()
    this._logWithDelayAndClearLastFrame(`⚠ ${text}`)
  }

  info (text = this.text) {
    this.stop()
    this._logWithDelayAndClearLastFrame(`ℹ ${text}`)
  }

  stop (withRestore = true) {
    if (withRestore) this._hardStop = true

    clearInterval(this.interval)

    process.stdout.write(ansiEscapes.eraseLineEnd) // Clear line

    this.isSpinning = false
    if (withRestore) this._restoreConsole()
  }

  _patchConsole () {
    const methods = ['log', 'warn', 'error', 'info', 'debug']
    for (const m of methods) {
      this._origConsole[m] = console[m]
      const loader = this
      console[m] = function (...args) {
        // Queue all log calls
        loader._consoleQueue.push({ method: m, args })

        // Debounce: If there's an existing timeout, clear it
        if (loader._consoleTimeout) clearTimeout(loader._consoleTimeout)

        loader.isSpinning && loader.stop(false)

        // Start (or restart) the timer
        loader._consoleTimeout = setTimeout(() => {
          for (const entry of loader._consoleQueue) {
            loader._origConsole[entry.method].apply(console, entry.args)
          }
          loader._consoleQueue = []
          loader._consoleTimeout = null
          !loader.isSpinning && loader._runSpinner()
        }, loader.ioTimeoutMS)
      }
    }
    this._isConsolePatched = true
  }

  _restoreConsole () {
    for (const m in this._origConsole) {
      console[m] = this._origConsole[m]
    }
    this._isConsolePatched = false
  }

  _runSpinner () {
    if (this.isSpinning || this._hardStop) return

    this.isSpinning = true

    this.interval = setInterval(() => {
      const frame = this.frames[this.frameIndex]
      process.stdout.write(`${ansiEscapes.eraseLineEnd}${frame} ${this.text}\r`)
      this.frameIndex = (this.frameIndex + 1) % this.frames.length
    }, 80)
  }

  _logWithDelayAndClearLastFrame (text) {
    setTimeout(() => {
      console.log('\x1b[A\r\x1b[2K')
      console.log(text)
    }, this.ioTimeoutMS + 50)
  }
}

const loader = new TerminalLoader()

module.exports = { TerminalLoader, loader }
