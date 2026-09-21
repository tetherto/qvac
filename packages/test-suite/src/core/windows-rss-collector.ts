import { spawn, type ChildProcess } from 'node:child_process'
import { parseProcessRssTable, sumProcessTreeRssKb } from './process-tree-rss.js'

/**
 * Persistent Windows process-tree RSS collector.
 *
 * Spawning PowerShell for every 200 ms tick is far too expensive (cold start
 * is hundreds of milliseconds). Instead we keep one `powershell.exe` alive
 * and ask it for a CIM snapshot over stdin/stdout:
 *
 *   Node writes a newline  ->  PowerShell dumps `pid ppid rssKb` lines
 *                           ->  sentinel `---`
 *
 * WorkingSetSize is converted to kibibytes in PowerShell so the shared
 * parser stays identical to the POSIX `ps` collector.
 */

const SNAPSHOT_SENTINEL = '---'
const SNAPSHOT_TIMEOUT_MS = 8000

interface WindowsRssSnapshot {
  raw: string
  collectorPid: number | undefined
}

interface PendingSnapshot {
  child: ChildProcess
  deliver: (snapshot: WindowsRssSnapshot | null) => void
}

const COLLECTOR_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Continue'",
  '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false',
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$OutputEncoding = [Console]::OutputEncoding',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize |',
  '    ForEach-Object {',
  '      $procId = $_.ProcessId',
  '      $parentId = $_.ParentProcessId',
  '      if ($null -eq $procId) { return }',
  '      if ($null -eq $parentId) { $parentId = 0 }',
  '      $rssKb = [long][Math]::Floor(([uint64]$_.WorkingSetSize) / 1024)',
  "      '{0} {1} {2}' -f $procId, $parentId, $rssKb",
  '    }',
  `  '${SNAPSHOT_SENTINEL}'`,
  '  [Console]::Out.Flush()',
  '}'
].join('\n')

function resolvePowerShellExecutable(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  return root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function logMem(message: string): void {
  console.warn(`[node-mem] ${message}`)
}

function unrefStream(stream: object | null): void {
  const unref = (stream as { unref?: () => void } | null)?.unref
  unref?.call(stream)
}

export class WindowsRssCollector {
  private child: ChildProcess | null = null
  private buffer = ''
  private lines: string[] = []
  private pending: PendingSnapshot | null = null
  private stderrTail = ''
  private stopping = new WeakSet<ChildProcess>()

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  start(): void {
    if (this.alive) return

    const executable = resolvePowerShellExecutable()
    const child = spawn(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShellCommand(COLLECTOR_SCRIPT)
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    )

    this.child = child
    this.buffer = ''
    this.lines = []
    this.pending = null
    this.stderrTail = ''
    child.unref()
    unrefStream(child.stdin)
    unrefStream(child.stdout)
    unrefStream(child.stderr)

    child.on('spawn', () => {
      if (this.child !== child) return
      console.log(`[node-mem] windows powershell-cim collector started pid=${child.pid}`)
    })

    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.consumeStdout(child, typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (this.child !== child) return
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.stderrTail = (this.stderrTail + text).slice(-2000)
    })

    child.stdin?.on('error', (error: Error) => {
      if (this.child !== child) return
      logMem(`powershell collector stdin failed: ${error.message}`)
      this.child = null
      this.settlePending(null)
      child.kill()
    })

    child.on('error', (error: Error) => {
      if (this.child !== child) return
      logMem(`powershell collector failed to start: ${error.message}`)
      this.child = null
      this.settlePending(null)
    })

    child.on('exit', (code, signal) => {
      const intentional = this.stopping.delete(child)
      if (this.child !== child) return
      this.child = null
      this.settlePending(null)
      if (intentional) return
      const detail = this.stderrTail.trim()
      const reason = signal ? `signal ${signal}` : `code ${code}`
      logMem(
        detail
          ? `powershell collector exited (${reason}): ${detail}`
          : `powershell collector exited (${reason})`
      )
    })
  }

  stop(): void {
    const child = this.child
    this.child = null
    this.settlePending(null)
    this.buffer = ''
    this.lines = []
    if (!child) return
    this.stopping.add(child)
    try {
      child.stdin?.end()
    } catch {
      // ignore
    }
    try {
      child.kill()
    } catch {
      // already gone
    }
  }

  async collectTreeRssKb(rootPid: number): Promise<number | null> {
    const snapshot = await this.requestSnapshot(SNAPSHOT_TIMEOUT_MS)
    if (snapshot === null) return null
    const excludedPids = new Set<number>()
    if (snapshot.collectorPid !== undefined) excludedPids.add(snapshot.collectorPid)
    return sumProcessTreeRssKb(parseProcessRssTable(snapshot.raw), rootPid, excludedPids)
  }

  private requestSnapshot(timeoutMs: number): Promise<WindowsRssSnapshot | null> {
    this.start()
    if (!this.alive || !this.child || this.pending) return Promise.resolve(null)

    const child = this.child
    return new Promise((resolve) => {
      const pending: PendingSnapshot = {
        child,
        deliver(snapshot) {
          clearTimeout(timer)
          resolve(snapshot)
        }
      }
      const timer = setTimeout(() => {
        if (this.pending !== pending) return
        logMem('windows RSS snapshot timed out; restarting powershell collector')
        this.settlePending(null)
        this.stop()
      }, timeoutMs)
      timer.unref?.()

      this.pending = pending
      this.stderrTail = ''
      try {
        child.stdin?.write('\n')
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        logMem(`failed to request windows RSS snapshot: ${message}`)
        this.settlePending(null)
      }
    })
  }

  private consumeStdout(child: ChildProcess, chunk: string): void {
    if (this.child !== child) return
    this.buffer += chunk
    const parts = this.buffer.split(/\r?\n/)
    this.buffer = parts.pop() ?? ''
    for (const line of parts) {
      if (line.trim() === SNAPSHOT_SENTINEL) {
        const snapshot = this.lines.join('\n')
        this.lines = []
        if (!snapshot && this.stderrTail.trim()) {
          logMem(`powershell CIM query failed: ${this.stderrTail.trim()}`)
        }
        this.settlePending({ raw: snapshot, collectorPid: child.pid })
      } else {
        this.lines.push(line)
      }
    }
  }

  private settlePending(snapshot: WindowsRssSnapshot | null): void {
    const pending = this.pending
    this.pending = null
    pending?.deliver(snapshot)
  }
}
