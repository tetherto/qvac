import { spawn, execSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import mqtt from 'mqtt'

export interface TrackedProcess {
  name: string
  pid: number
  child: ChildProcess
  logPath: string
}

export interface SpawnTrackedOptions {
  reportDir: string
  name: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Color code for the label prefix (ANSI). Defaults cycle through a palette. */
  color?: string
  /** If true, only write to log file, don't print to console. */
  silent?: boolean
}

const LABEL_COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m', '\x1b[34m']
const RESET = '\x1b[0m'
let colorIndex = 0

function prefixLines(chunk: Buffer, prefix: string): string {
  const text = chunk.toString()
  if (!text) return ''
  return (
    text
      .split('\n')
      .map((line, i, arr) => {
        if (i === arr.length - 1 && line === '') return ''
        return `${prefix} ${line}`
      })
      .filter(Boolean)
      .join('\n') + '\n'
  )
}

/**
 * Spawn a child process with PID + log file tracking.
 * stdout/stderr are piped to both the parent console (with colored label prefix)
 * and a log file (without prefix).
 */
export function spawnTracked(
  command: string,
  args: string[],
  opts: SpawnTrackedOptions
): TrackedProcess {
  const logPath = path.join(opts.reportDir, `${opts.name}.log`)
  const pidPath = path.join(opts.reportDir, `${opts.name}.pid`)

  const logStream = fs.createWriteStream(logPath, { flags: 'a' })
  const color = opts.color ?? LABEL_COLORS[colorIndex++ % LABEL_COLORS.length]
  const prefix = `${color}[${opts.name}]${RESET}`

  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const pid = child.pid!
  fs.writeFileSync(pidPath, String(pid))

  child.stdout?.on('data', (chunk: Buffer) => {
    logStream.write(chunk)
    if (!opts.silent) process.stdout.write(prefixLines(chunk, prefix))
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    logStream.write(chunk)
    if (!opts.silent) process.stderr.write(prefixLines(chunk, prefix))
  })

  child.on('close', () => {
    logStream.end()
  })

  return { name: opts.name, pid, child, logPath }
}

/**
 * Kill all tracked processes by reading .pid files from the report directory.
 */
export function killTracked(reportDir: string): void {
  if (!fs.existsSync(reportDir)) return

  const pidFiles = fs.readdirSync(reportDir).filter((f) => f.endsWith('.pid'))
  for (const pidFile of pidFiles) {
    try {
      const pid = parseInt(fs.readFileSync(path.join(reportDir, pidFile), 'utf-8').trim(), 10)
      if (!isNaN(pid)) {
        if (process.platform === 'win32') {
          try {
            execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' })
          } catch {
            // process already exited
          }
        } else {
          try {
            process.kill(pid, 'SIGTERM')
          } catch {
            // process already exited
          }
        }
      }
    } catch {
      // ignore read errors
    }
  }
}

/**
 * Print a formatted PID summary table.
 */
export function printPidTable(
  entries: Array<{ name: string; pid: number; logPath: string }>
): void {
  const nameWidth = Math.max(10, ...entries.map((e) => e.name.length))
  const pidWidth = 8

  console.log('')
  console.log(`  ${'Process'.padEnd(nameWidth)}  ${'PID'.padEnd(pidWidth)}  Log`)
  console.log(`  ${'─'.repeat(nameWidth)}  ${'─'.repeat(pidWidth)}  ${'─'.repeat(40)}`)
  for (const entry of entries) {
    console.log(
      `  ${entry.name.padEnd(nameWidth)}  ${String(entry.pid).padEnd(pidWidth)}  ${entry.logPath}`
    )
  }
  console.log('')
}

/**
 * Detect the LAN IP address. Uses os.networkInterfaces() (pure Node, cross-platform).
 */
export function detectLanIp(): string | undefined {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name]
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address
      }
    }
  }
  return undefined
}

/**
 * Check if an MQTT broker is reachable at the given URL within a timeout.
 */
export function checkBroker(brokerUrl: string, timeoutMs: number = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const client = mqtt.connect(brokerUrl, {
      connectTimeout: timeoutMs,
      reconnectPeriod: 0
    })

    const timer = setTimeout(() => {
      client.end(true)
      resolve(false)
    }, timeoutMs)

    client.on('connect', () => {
      clearTimeout(timer)
      client.end(true)
      resolve(true)
    })

    client.on('error', () => {
      clearTimeout(timer)
      client.end(true)
      resolve(false)
    })
  })
}

/**
 * Create the report directory, returning its absolute path.
 */
export function createReportDir(configDir: string, runId: string, overrideDir?: string): string {
  const reportDir = overrideDir
    ? path.resolve(overrideDir)
    : path.resolve(configDir, 'reports', `local-${runId}`)
  fs.mkdirSync(reportDir, { recursive: true })
  return reportDir
}

/**
 * Generate a local run ID from the current timestamp.
 */
export function generateRunId(): string {
  return `local-${Date.now()}`
}

/**
 * Start capturing device logs to a file (silent -- no console output).
 * Returns the child process for cleanup, or undefined if the tool isn't available.
 */
export function startDeviceLogCapture(
  reportDir: string,
  platform: 'ios' | 'android',
  opts: { udid?: string; serial?: string; packageName?: string }
): { child: ReturnType<typeof spawn>; logPath: string } | undefined {
  const logPath = path.join(reportDir, 'device.log')
  const logFd = fs.openSync(logPath, 'w')

  try {
    if (platform === 'ios' && opts.udid) {
      // Try idevicesyslog
      try {
        execSync('which idevicesyslog', { encoding: 'utf-8', stdio: 'pipe' })
        const child = spawn('idevicesyslog', ['-u', opts.udid, '--no-colors'], {
          stdio: ['ignore', logFd, logFd]
        })
        return { child, logPath }
      } catch {}
    }

    if (platform === 'android' && opts.serial) {
      // adb logcat, optionally filtered by package PID
      const args = ['-s', opts.serial, 'logcat', '-v', 'brief']
      if (opts.packageName) {
        try {
          const pid = execSync(`adb -s ${opts.serial} shell pidof ${opts.packageName}`, {
            encoding: 'utf-8'
          }).trim()
          if (pid) args.push('--pid', pid)
        } catch {}
      }
      const child = spawn('adb', args, {
        stdio: ['ignore', logFd, logFd]
      })
      return { child, logPath }
    }
  } catch {}

  fs.closeSync(logFd)
  return undefined
}

/**
 * Print log file paths for the user.
 */
export function printLogPaths(reportDir: string): void {
  if (!fs.existsSync(reportDir)) return
  const logFiles = fs.readdirSync(reportDir).filter((f) => f.endsWith('.log'))
  if (logFiles.length === 0) return

  console.log('📄 Log files:')
  for (const file of logFiles.sort()) {
    console.log(`   ${path.join(reportDir, file)}`)
  }
  console.log('')
}
