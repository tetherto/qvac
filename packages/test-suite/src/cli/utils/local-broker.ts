import * as fs from 'node:fs'
import * as path from 'node:path'
import * as net from 'node:net'
import * as http from 'node:http'
import * as readline from 'node:readline'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { checkBroker } from './process-manager.js'

const MQTT_PORT = 1883
const WS_PORT = 8080

export interface BrokerHandle {
  started: boolean
  cleanup: () => void
}

function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'y')
    })
  })
}

/**
 * Try to require a module from local node_modules first,
 * then from the global npm prefix.
 */
function tryRequire(moduleName: string): any {
  // Try local first (resolves from the framework's node_modules)
  try {
    const localRequire = createRequire(import.meta.url)
    return localRequire(moduleName)
  } catch {}

  // Try from the project's node_modules (cwd)
  try {
    const cwdRequire = createRequire(path.join(process.cwd(), 'node_modules', '_'))
    return cwdRequire(moduleName)
  } catch {}

  // Try global: create a require scoped to the global node_modules dir
  try {
    const globalDir = execSync('npm root -g', { encoding: 'utf-8', timeout: 5000 }).trim()
    const globalRequire = createRequire(path.join(globalDir, '_'))
    return globalRequire(moduleName)
  } catch {}

  return undefined
}

/**
 * Ensure an MQTT broker is available with both TCP and WebSocket protocols.
 * Checks localhost in addition to the configured URL (which may be a stale LAN IP).
 *
 * If TCP is up but WS is not, prints a clear error since both are always required.
 */
export async function ensureBroker(brokerUrl: string, reportDir: string): Promise<BrokerHandle> {
  const localTcp = `mqtt://127.0.0.1:${MQTT_PORT}`
  const localWs = `ws://127.0.0.1:${WS_PORT}`

  // Check TCP reachability (config URL + localhost)
  const tcpUrls = brokerUrl.startsWith('mqtt') ? [brokerUrl, localTcp] : [localTcp]
  let tcpReachable = false
  let tcpFoundAt = ''
  for (const url of [...new Set(tcpUrls)]) {
    if (await checkBroker(url, 2000)) {
      tcpReachable = true
      tcpFoundAt = url
      break
    }
  }

  // Check WS reachability (config URL + localhost)
  const wsUrls = brokerUrl.startsWith('ws') ? [brokerUrl, localWs] : [localWs]
  let wsReachable = false
  let wsFoundAt = ''
  for (const url of [...new Set(wsUrls)]) {
    if (await checkBroker(url, 2000)) {
      wsReachable = true
      wsFoundAt = url
      break
    }
  }

  // Both protocols available
  if (tcpReachable && wsReachable) {
    console.log(`✅ MQTT broker already running (${tcpFoundAt}, ${wsFoundAt})`)
    return { started: false, cleanup: () => {} }
  }

  // TCP up but WS missing -- can't start embedded broker on occupied port
  if (tcpReachable && !wsReachable) {
    console.error(
      `\n❌ MQTT broker found at ${tcpFoundAt} but no WebSocket broker on port ${WS_PORT}.\n` +
        '   Both TCP and WebSocket are required.\n\n' +
        '   Options:\n' +
        `     1. Stop the current broker and let this command start an embedded one (TCP + WS)\n` +
        `     2. Configure your broker to also listen on ws://0.0.0.0:${WS_PORT}\n`
    )
    process.exit(1)
  }

  // Nothing running -- start embedded broker
  console.log(`⚠️  No MQTT broker detected, attempting to start one...`)

  const aedesPkg = tryRequire('aedes')
  const wsStream = tryRequire('websocket-stream')

  if (!aedesPkg || !wsStream) {
    console.log(
      '\n   No MQTT broker is running and the embedded broker dependencies are not installed.\n' +
        '   The embedded broker provides both TCP (:1883) and WebSocket (:8080) protocols.\n' +
        '   WebSocket is required for mobile clients to connect.\n'
    )

    const confirmed = await promptYesNo(
      '   Install aedes + websocket-stream globally? (npm install -g)'
    )
    if (confirmed) {
      console.log('\n   Installing...')
      execSync('npm install -g aedes websocket-stream', { stdio: 'inherit' })
      console.log('')

      // Retry require after install
      const aedesRetry = tryRequire('aedes')
      const wsRetry = tryRequire('websocket-stream')
      if (!aedesRetry || !wsRetry) {
        console.error(
          '❌ Installation succeeded but modules still not found. Start a broker manually.'
        )
        process.exit(1)
      }
      return ensureBroker(brokerUrl, reportDir)
    } else {
      console.error('\n   Start a broker manually before running this command.')
      process.exit(1)
    }
  }

  // v1.x CJS: { Aedes } where Aedes.createBroker() is a static method
  // v1.x ESM: { createBroker } at top level
  // v0.x CJS: module.exports is a callable factory
  let broker: any
  if (typeof aedesPkg.Aedes?.createBroker === 'function') {
    broker = await aedesPkg.Aedes.createBroker()
  } else if (typeof aedesPkg.createBroker === 'function') {
    broker = await aedesPkg.createBroker()
  } else if (typeof aedesPkg.default?.createBroker === 'function') {
    broker = await aedesPkg.default.createBroker()
  } else if (typeof aedesPkg.default?.Aedes?.createBroker === 'function') {
    broker = await aedesPkg.default.Aedes.createBroker()
  } else {
    throw new Error(
      `Could not create aedes broker: unrecognized module shape (keys: ${Object.keys(aedesPkg).join(', ')})`
    )
  }

  const tcpServer = net.createServer(broker.handle)
  const httpServer = http.createServer()

  const wsModule = wsStream.default ?? wsStream
  wsModule.createServer({ server: httpServer }, broker.handle)

  await new Promise<void>((resolve, reject) => {
    tcpServer.listen(MQTT_PORT, '0.0.0.0', () => {
      httpServer.listen(WS_PORT, '0.0.0.0', () => resolve())
    })
    tcpServer.on('error', reject)
    httpServer.on('error', reject)
  })

  console.log(`✅ Embedded MQTT broker started (TCP :${MQTT_PORT}, WS :${WS_PORT})`)

  fs.writeFileSync(path.join(reportDir, 'broker.pid'), String(process.pid))

  const cleanup = () => {
    try {
      tcpServer.close()
    } catch {}
    try {
      httpServer.close()
    } catch {}
    try {
      broker.close()
    } catch {}
  }

  return { started: true, cleanup }
}
