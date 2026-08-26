import * as fs from 'node:fs'
import * as path from 'node:path'

interface EnvValues {
  MQTT_PROTOCOL: string
  MQTT_HOST: string
  MQTT_PORT: string
  MQTT_PATH: string
}

/**
 * Parse a .env file into a Map of key->value, preserving order via an array of lines.
 */
function parseEnvFile(content: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    map.set(key, value)
  }
  return map
}

/**
 * Merge desired keys into an existing .env content string.
 * Existing keys are updated in-place; missing keys are appended.
 * Comments and blank lines are preserved.
 */
function mergeEnv(existingContent: string, desired: EnvValues): string {
  const desiredMap = new Map(Object.entries(desired))
  const seen = new Set<string>()
  const lines = existingContent.split('\n')

  const updated = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) return line
    const key = trimmed.slice(0, eqIdx).trim()
    if (desiredMap.has(key)) {
      seen.add(key)
      return `${key}=${desiredMap.get(key)}`
    }
    return line
  })

  // Append any keys that weren't already present
  for (const [key, value] of desiredMap) {
    if (!seen.has(key)) {
      updated.push(`${key}=${value}`)
    }
  }

  return updated.join('\n')
}

/**
 * Write local MQTT WebSocket settings to .env for mobile builds.
 * Only backs up and rewrites if values actually differ.
 */
export function writeLocalMobileEnv(configDir: string, lanIp: string): void {
  const envPath = path.join(configDir, '.env')
  const desired: EnvValues = {
    MQTT_PROTOCOL: 'ws',
    MQTT_HOST: lanIp,
    MQTT_PORT: '8080',
    MQTT_PATH: ''
  }

  let existingContent = ''
  if (fs.existsSync(envPath)) {
    existingContent = fs.readFileSync(envPath, 'utf-8')
  }

  // Check if all values already match
  const existing = parseEnvFile(existingContent)
  const allMatch = Object.entries(desired).every(([key, value]) => existing.get(key) === value)

  if (allMatch) {
    console.log('✅ .env already configured for local broker')
    return
  }

  // Back up existing .env
  if (existingContent) {
    const backupPath = path.join(configDir, `.env.bak-${Date.now()}`)
    fs.writeFileSync(backupPath, existingContent)
    console.log(`📋 Backed up .env to ${path.basename(backupPath)}`)
  }

  // Merge and write
  const merged = mergeEnv(existingContent, desired)
  fs.writeFileSync(envPath, merged)

  const changed: string[] = []
  for (const [key, value] of Object.entries(desired)) {
    const old = existing.get(key)
    if (old !== value) {
      changed.push(`   ${key}: ${old ?? '(unset)'} → ${value}`)
    }
  }
  console.log(`✅ Updated .env for local broker:\n${changed.join('\n')}`)
}

/**
 * Restore the most recent .env backup.
 */
export function restoreEnvBackup(configDir: string): boolean {
  const files = fs.readdirSync(configDir).filter((f) => f.startsWith('.env.bak-'))
  if (files.length === 0) return false

  files.sort()
  const latest = files[files.length - 1]
  const backupPath = path.join(configDir, latest)
  const envPath = path.join(configDir, '.env')

  fs.copyFileSync(backupPath, envPath)
  console.log(`✅ Restored .env from ${latest}`)
  return true
}
