import { validateRequiredEnv } from './helpers.js'
import { Sanitizer } from './sanitizer.js'

/**
 * Base class for all actions-ci subcommands.
 *
 * Subclasses must implement:
 *   toCommand() — builds and returns the CLI command() instance
 *   _run(flags) — contains the actual domain logic
 *
 * Subclasses MUST NOT override run() — it is a template method that
 * automatically validates all declared secrets before calling _run().
 * This is a structural guarantee: secret validation cannot be skipped.
 *
 * To add a new subcommand:
 *   1. Create lib/commands/<name>/index.js — extend Command
 *   2. Create lib/commands/<name>/helpers.js — domain logic
 *   3. Call newCmd.toCommand() as a positional arg in main.js command()
 *   4. Write flat test files: test/unit/<name>-index.test.js, test/unit/<name>-helpers.test.js
 */
export class Command {
  constructor ({ name, description, secrets = [], sanitizer = new Sanitizer() }) {
    this.name = name
    this.description = description
    this.secrets = secrets
    this.sanitizer = sanitizer
  }

  toCommand () {
    throw new Error(this.name + ': toCommand() must be implemented')
  }

  async run (flags) {
    validateRequiredEnv(this.secrets.map(s => s.envVar))
    return this._run(flags)
  }

  async _run (flags) { // eslint-disable-line no-unused-vars
    throw new Error(this.name + ': _run() must be implemented')
  }

  _secretsFooter () {
    if (this.secrets.length === 0) return ''
    const maxLen = Math.max(...this.secrets.map(s => s.envVar.length))
    const lines = this.secrets.map(s => {
      const pad = ' '.repeat(maxLen - s.envVar.length + 2)
      return '  ' + s.envVar + pad + s.description
    })
    return 'Environment (required):\n' + lines.join('\n')
  }
}
