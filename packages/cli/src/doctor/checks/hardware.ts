import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { Check } from '../check.js'

const MIN_TOTAL_MEMORY_GB = 2
const RECOMMENDED_TOTAL_MEMORY_GB = 4
const RECOMMENDED_AVAILABLE_MEMORY_GB = 2
const RECOMMENDED_FREE_DISK_GB = 5

function toGB (bytes: number): number {
  return bytes / (1024 ** 3)
}

function fmtGB (bytes: number): string {
  return `${toGB(bytes).toFixed(2)} GB`
}

// Total RAM has a hard gate (<2 GB fails the report) with a recommended
// band on top, so the check is 'required' as a whole — the same pattern
// as checkNodeVersion. Severity describes the check itself, not the
// outcome of a particular branch.
export const checkTotalMemory: Check = (ctx) => {
  const totalBytes = ctx.totalMemoryBytes
  const gb = toGB(totalBytes)
  if (gb < MIN_TOTAL_MEMORY_GB) {
    return {
      id: 'memory-total',
      label: 'Total RAM',
      status: 'fail',
      severity: 'required',
      value: fmtGB(totalBytes),
      hint: `At least ${MIN_TOTAL_MEMORY_GB} GB of RAM is required to run QVAC models.`
    }
  }
  if (gb < RECOMMENDED_TOTAL_MEMORY_GB) {
    return {
      id: 'memory-total',
      label: 'Total RAM',
      status: 'warn',
      severity: 'required',
      value: fmtGB(totalBytes),
      hint: `Less than ${RECOMMENDED_TOTAL_MEMORY_GB} GB RAM detected; most LLMs will fail to load.`
    }
  }
  return {
    id: 'memory-total',
    label: 'Total RAM',
    status: 'pass',
    severity: 'required',
    value: fmtGB(totalBytes)
  }
}

export const checkAvailableMemory: Check = (ctx) => {
  const availableBytes = ctx.availableMemoryBytes
  const gb = toGB(availableBytes)
  if (gb < RECOMMENDED_AVAILABLE_MEMORY_GB) {
    return {
      id: 'memory-available',
      label: 'Available RAM',
      status: 'warn',
      severity: 'recommended',
      value: fmtGB(availableBytes),
      hint: `Less than ${RECOMMENDED_AVAILABLE_MEMORY_GB} GB available; close other applications before loading large models.`
    }
  }
  return {
    id: 'memory-available',
    label: 'Available RAM',
    status: 'pass',
    severity: 'recommended',
    value: fmtGB(availableBytes)
  }
}

interface StatfsLike { bsize: number, bavail: number }

function readFreeDiskBytes (dir: string): number | null {
  const statfs = (fs as unknown as { statfsSync?: (p: string) => StatfsLike }).statfsSync
  if (typeof statfs === 'function') {
    try {
      const info = statfs(dir)
      return info.bsize * info.bavail
    } catch {
      // fall through to shell fallback
    }
  }
  // Fallback for Node 18.0–18.14 on unix (statfsSync was added in 18.15).
  if (process.platform !== 'win32') {
    try {
      const r = spawnSync('df', ['-Pk', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
      if (r.error || r.status !== 0) return null
      const lines = r.stdout.toString('utf8').trim().split('\n')
      const row = lines[1]
      if (!row) return null
      const cols = row.trim().split(/\s+/)
      // Columns: Filesystem 1024-blocks Used Available Capacity Mounted
      const kb = cols.length >= 4 && cols[3] !== undefined ? Number.parseInt(cols[3], 10) : NaN
      if (!Number.isFinite(kb)) return null
      return kb * 1024
    } catch {
      return null
    }
  }
  return null
}

// QVAC inference backends rely on Metal on macOS and Vulkan on Linux/Windows
// (see the ggml-metal / whisper-cpp+vulkan CMake configs). Running LLM or
// Whisper inference without a GPU backend falls back to CPU, which is
// roughly an order of magnitude slower — worth flagging in the report.
function parseVulkanDeviceNames (stdout: string): string[] {
  const names: string[] = []
  for (const line of stdout.split('\n')) {
    const m = /deviceName\s*=\s*(.+)/.exec(line)
    if (m && m[1] !== undefined) names.push(m[1].trim())
  }
  return names
}

export const checkGpuAcceleration: Check = (ctx) => {
  if (ctx.platform === 'darwin') {
    return {
      id: 'gpu-acceleration',
      label: 'GPU acceleration',
      status: 'pass',
      severity: 'recommended',
      value: 'Metal (native macOS backend)'
    }
  }
  if (ctx.platform !== 'linux' && ctx.platform !== 'win32') {
    return {
      id: 'gpu-acceleration',
      label: 'GPU acceleration',
      status: 'info',
      severity: 'informational',
      value: `not checked on ${ctx.platform}`,
      hint: `'qvac doctor' does not validate GPU acceleration on ${ctx.platform}.`
    }
  }
  const r = ctx.probe('vulkaninfo', ['--summary'])
  if (!r.ok) {
    const installHint = ctx.platform === 'win32'
      ? 'Install the Vulkan runtime via the latest GPU drivers or the Vulkan SDK (https://vulkan.lunarg.com/).'
      : 'Install a Vulkan loader and vulkan-tools (Debian/Ubuntu: `apt install libvulkan1 vulkan-tools`; Fedora: `dnf install vulkan-tools vulkan-loader`).'
    return {
      id: 'gpu-acceleration',
      label: 'GPU acceleration',
      status: 'warn',
      severity: 'recommended',
      value: 'Vulkan ICD not found',
      hint: `${installHint} Without a Vulkan ICD, QVAC inference falls back to CPU and is significantly slower.`
    }
  }
  const devices = parseVulkanDeviceNames(r.stdout ?? '')
  if (devices.length === 0) {
    return {
      id: 'gpu-acceleration',
      label: 'GPU acceleration',
      status: 'pass',
      severity: 'recommended',
      value: 'Vulkan ICD present',
      hint: 'vulkaninfo reported no GPU devices; ensure a GPU driver is installed if you expect hardware acceleration.'
    }
  }
  return {
    id: 'gpu-acceleration',
    label: 'GPU acceleration',
    status: 'pass',
    severity: 'recommended',
    value: `Vulkan: ${devices.join(', ')}`
  }
}

export const checkFreeDiskSpace: Check = (ctx) => {
  const dir = ctx.projectRoot
  const free = readFreeDiskBytes(dir)
  if (free === null) {
    return {
      id: 'disk-free',
      label: `Free disk space (${dir})`,
      status: 'skip',
      severity: 'recommended',
      hint: 'Disk space check requires Node.js v18.15+ (fs.statfsSync) or a POSIX `df` on PATH.'
    }
  }
  if (toGB(free) < RECOMMENDED_FREE_DISK_GB) {
    return {
      id: 'disk-free',
      label: `Free disk space (${dir})`,
      status: 'warn',
      severity: 'recommended',
      value: fmtGB(free),
      hint: `Less than ${RECOMMENDED_FREE_DISK_GB} GB free; model downloads are typically multi-GB.`
    }
  }
  return {
    id: 'disk-free',
    label: `Free disk space (${dir})`,
    status: 'pass',
    severity: 'recommended',
    value: fmtGB(free)
  }
}
