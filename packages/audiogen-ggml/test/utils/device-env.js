'use strict'

// Parser for the KEY=VALUE config the mobile CI pushes to the device before the
// tests start. Pure so it can be unit-tested without bare-os or a device.

const COMMENT_PREFIX = '#'

// The workflow joins entries with a literal backslash-n so the value survives as
// a single-line JS string in the WDIO template; real newlines are accepted too.
function normalizeNewlines(raw) {
  return String(raw).replace(/\\n/g, '\n')
}

function isSkippableLine(line) {
  return line === '' || line.startsWith(COMMENT_PREFIX)
}

// Split on the first '=' only, so a value may itself contain '='.
function parseEntry(line) {
  const separator = line.indexOf('=')
  if (separator <= 0) return null
  const key = line.slice(0, separator).trim()
  const value = line.slice(separator + 1).trim()
  if (!key || !value) return null
  return { key, value }
}

function parseDeviceEnv(raw) {
  if (!raw) return []
  return normalizeNewlines(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !isSkippableLine(line))
    .map(parseEntry)
    .filter(Boolean)
}

function applyDeviceEnv(raw, setEnv) {
  const entries = parseDeviceEnv(raw)
  for (const { key, value } of entries) setEnv(key, value)
  return entries.length
}

module.exports = {
  parseDeviceEnv,
  applyDeviceEnv
}
