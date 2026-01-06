'use strict'

const process = require('process')
const fs = require('fs')
const path = require('path')

let envCache = null

function loadEnvFile () {
  if (envCache !== null) return envCache

  envCache = {}
  const envPath = path.join(process.cwd(), '.env')
  try {
    const envContent = fs.readFileSync(envPath, 'utf8')
    const lines = envContent.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const [key, ...valueParts] = trimmed.split('=')
      if (key) {
        let value = valueParts.join('=')
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
          value = value.slice(1, -1)
        }
        envCache[key.trim()] = value
      }
    }
  } catch (err) {
    // .env file is optional - not an error if missing
    envCache = {}
  }
  return envCache
}

function getEnv (key, defaultValue = undefined) {
  if (process.env[key] !== undefined) {
    return process.env[key]
  }
  const envVars = loadEnvFile()
  if (envVars[key] !== undefined) {
    return envVars[key]
  }
  return defaultValue
}

function requireEnv (key) {
  const value = getEnv(key)
  if (value === undefined) throw new Error(`Required environment variable ${key} not found in process.env or .env file`)
  return value
}

function getEnvJSON (key, defaultValue = {}) {
  const value = getEnv(key)
  if (!value) return defaultValue
  try {
    return JSON.parse(value)
  } catch (err) {
    // Invalid JSON in environment variable, return default
    return defaultValue
  }
}

function updateEnvFile (key, value) {
  const envPath = path.join(process.cwd(), '.env')
  try {
    let envContent = ''
    if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf8')
    let formattedValue = value
    if (typeof value === 'object') formattedValue = `'${JSON.stringify(value)}'`
    else if (typeof value === 'string' && !value.startsWith('"') && !value.startsWith('\'')) {
      if (value.includes(' ') || value.includes('=')) formattedValue = `'${value}'`
    }
    const newLine = `${key}=${formattedValue}`
    if (envContent.includes(`${key}=`)) envContent = envContent.replace(new RegExp(`^${key}=.*$`, 'm'), newLine)
    else envContent = envContent.trimEnd() + `\n${newLine}\n`
    fs.writeFileSync(envPath, envContent)
    envCache = null
    return true
  } catch (err) {
    return false
  }
}

function removeEnvKey (key) {
  const envPath = path.join(process.cwd(), '.env')
  try {
    if (!fs.existsSync(envPath)) return true
    const envContent = fs.readFileSync(envPath, 'utf8')
    const lines = envContent.split('\n')
    const filteredLines = lines.filter(line => {
      const trimmed = line.trim()
      if (!trimmed) return true
      if (trimmed.startsWith('#')) return true
      const lineKey = trimmed.split('=')[0].trim()
      return lineKey !== key
    })
    fs.writeFileSync(envPath, filteredLines.join('\n'))
    envCache = null
    return true
  } catch (err) {
    return false
  }
}

module.exports = {
  getEnv,
  requireEnv,
  getEnvJSON,
  loadEnvFile,
  updateEnvFile,
  removeEnvKey
}
