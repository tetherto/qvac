'use strict'

// Generic, domain-agnostic utilities.
// No GitHub, no CI-domain logic — no secret patterns either.
// Each subcommand defines its own secret patterns and sanitizeError in its own helpers.js.
// Any subcommand or future JS action can use these.

function exitWithError (message, code) {
  process.stderr.write(String(message) + '\n')
  process.exit(code === undefined ? 1 : code)
}

function validateRequiredEnv (vars) {
  const missing = vars.filter(v => !process.env[v])
  if (missing.length > 0) {
    throw new Error(
      'Missing required environment variable' + (missing.length > 1 ? 's' : '') +
      ': ' + missing.join(', ')
    )
  }
}

function validatePrNumber (raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw new RangeError('--pr-number is required')
  }
  const n = parseInt(String(raw), 10)
  if (isNaN(n) || n < 1) {
    throw new RangeError('--pr-number must be a positive integer, got: ' + String(raw))
  }
  return n
}

function validateRepo (raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error(
      '--repo is required (or set $GITHUB_REPOSITORY). ' +
      'Expected format: owner/repo'
    )
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(raw)) {
    throw new Error(
      'Invalid repo format: ' + JSON.stringify(raw) + '. Expected: owner/repo'
    )
  }
  const [owner, repo] = raw.split('/')
  return { owner, repo }
}

function validateTeamSlug (raw, flagName) {
  if (!raw || typeof raw !== 'string') {
    throw new Error(flagName + ' is required')
  }
  if (!/^[a-zA-Z0-9-]+$/.test(raw)) {
    throw new Error(
      'Invalid ' + flagName + ' slug: ' + JSON.stringify(raw) +
      '. Expected: letters, digits, and hyphens only'
    )
  }
  return raw
}

module.exports = {
  exitWithError,
  validateRequiredEnv,
  validatePrNumber,
  validateRepo,
  validateTeamSlug
}
