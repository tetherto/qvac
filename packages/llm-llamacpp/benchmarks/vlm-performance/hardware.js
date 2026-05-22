'use strict'

// Best-effort hardware detection. Runs on the orchestrator, results
// are stamped into the per-platform JSON so the consolidated report
// shows *what hardware* produced each row. Each probe is wrapped in
// try/catch so a missing tool (no nvidia-smi, no wmic, etc.) just
// leaves the field null rather than failing the run.

const { execSync } = require('child_process')
const os = require('os')

function safeExec (cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, ...opts }).toString().trim()
  } catch {
    return null
  }
}

function detectCpu () {
  const cpus = os.cpus()
  return {
    model: cpus[0] && cpus[0].model ? cpus[0].model.replace(/\s+/g, ' ').trim() : null,
    cores: cpus.length,
    arch: os.arch()
  }
}

function detectRam () {
  // os.totalmem is reliable on every platform Node supports.
  return { totalGb: Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100 }
}

function detectGpuLinux () {
  // Prefer nvidia-smi → vulkaninfo → lspci VGA line. Each command may
  // be absent on a given runner; we just collect what we find.
  const gpus = []
  const nvidia = safeExec('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits')
  if (nvidia) {
    for (const line of nvidia.split('\n')) {
      const [name, memMib] = line.split(',').map((s) => s && s.trim())
      if (name) gpus.push({ vendor: 'NVIDIA', model: name, memoryMb: Number(memMib) || null, source: 'nvidia-smi' })
    }
  }
  if (gpus.length === 0) {
    const lspci = safeExec("lspci | grep -iE 'vga|3d|display'")
    if (lspci) {
      for (const line of lspci.split('\n')) {
        gpus.push({ vendor: null, model: line.replace(/^\s*\S+\s+(?:VGA|3D|Display)[^:]*:\s*/i, '').trim(), source: 'lspci' })
      }
    }
  }
  return gpus
}

function detectGpuWindows () {
  // PowerShell's CIM is the modern replacement for wmic (deprecated in
  // Windows 11). Format-List with a Width is needed because the default
  // table format truncates long adapter names.
  const ps = safeExec('powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | Format-List | Out-String -Width 4096"')
  if (!ps) return []
  const gpus = []
  let current = {}
  for (const line of ps.split(/\r?\n/)) {
    const m = line.match(/^(Name|AdapterRAM)\s*:\s*(.*)$/)
    if (!m) {
      if (current.model) { gpus.push(current); current = {} }
      continue
    }
    if (m[1] === 'Name') current.model = m[2].trim()
    else if (m[1] === 'AdapterRAM') {
      const n = Number(m[2])
      current.memoryMb = Number.isFinite(n) && n > 0 ? Math.round(n / (1024 * 1024)) : null
    }
    current.source = 'Win32_VideoController'
  }
  if (current.model) gpus.push(current)
  return gpus
}

function detectGpuMac () {
  // system_profiler is on every macOS box. Apple Silicon GPUs are
  // reported under "Chipset Model: Apple M3" etc.
  const sp = safeExec("system_profiler SPDisplaysDataType -json")
  if (!sp) return []
  try {
    const data = JSON.parse(sp)
    const list = (data.SPDisplaysDataType || []).map((d) => ({
      vendor: d.spdisplays_vendor || null,
      model: d.sppci_model || d._name || null,
      memoryMb: d.spdisplays_vram ? Number(String(d.spdisplays_vram).replace(/[^\d]/g, '')) || null : null,
      source: 'system_profiler'
    }))
    return list.filter((x) => x.model)
  } catch {
    return []
  }
}

function detectGpu () {
  switch (os.platform()) {
    case 'linux': return detectGpuLinux()
    case 'win32': return detectGpuWindows()
    case 'darwin': return detectGpuMac()
    default: return []
  }
}

function detectAll () {
  return {
    platform: os.platform(),
    arch: os.arch(),
    osRelease: os.release(),
    cpu: detectCpu(),
    ram: detectRam(),
    gpus: detectGpu(),
    detectedAt: new Date().toISOString()
  }
}

function hasUsableGpu (info) {
  // Heuristic: a runner has a "real" GPU when we found at least one
  // dedicated GPU adapter that isn't the basic Microsoft-shipped
  // display device or a software renderer. The addon will still make
  // the final decision at load time; we use this only to drop the
  // matrix row when there's clearly no point requesting GPU.
  if (!info || !Array.isArray(info.gpus)) return false
  return info.gpus.some((g) => {
    const m = String(g.model || '').toLowerCase()
    if (!m) return false
    // Filter out generic/virtual adapters that real workloads can't use.
    if (m.includes('microsoft basic display')) return false
    if (m.includes('microsoft hyper-v')) return false
    if (m.includes('software adapter')) return false
    if (m.includes('llvmpipe')) return false
    return true
  })
}

module.exports = { detectAll, hasUsableGpu }

if (require.main === module) {
  console.log(JSON.stringify(detectAll(), null, 2))
}
