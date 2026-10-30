'use strict'

const path = require('bare-path')
const os = require('bare-os')
const fs = require('bare-fs')
const proc = require('bare-process')
const test = require('brittle')

const PREBUILDS_DIR = path.resolve(__dirname, '../../prebuilds')

function moduleNameForHost(host) {
  const suffix = host.startsWith('ios-') ? 'ios' : host
  return 'qvac__diffusion-cpp-' + suffix
}

// GPU userspace loaders that must never be a hard DT_NEEDED of the addon
// module itself: a CPU-only server has none of them installed, and a hard
// link makes the whole worker abort at addon load (QVAC-23767 / gh#3853).
const FORBIDDEN_NEEDED = [
  'libvulkan.',
  'libOpenCL.',
  'libcuda.',
  'libcudart.',
  'libcublas.',
  'libcublasLt.'
]

// The prebuild must also stay self-contained w.r.t. the C++ runtime: neither
// libc++ nor libstdc++ is guaranteed on a minimal Linux install, so a NEEDED
// on either breaks dlopen the same way (both the addon and the backend
// modules link the C++ runtime statically).
const FORBIDDEN_RUNTIME = ['libc++.', 'libc++abi.', 'libstdc++.']

// 32-bit-pair read of a little-endian u64: ELF file offsets/sizes here are
// far below 2^53, and bare's Buffer does not guarantee the BigInt readers.
function readU64(buffer, off) {
  return buffer.readUInt32LE(off) + buffer.readUInt32LE(off + 4) * 0x100000000
}

// Minimal ELF64 dynamic-section reader: returns the DT_NEEDED entries of a
// shared object. Enough for the prebuild artifacts this test inspects; not a
// general ELF parser.
function elfNeeded(buffer) {
  const isElf =
    buffer.length > 0x40 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  if (!isElf) throw new Error('not an ELF file')
  if (buffer[4] !== 2) throw new Error('only ELF64 is supported')
  if (buffer[5] !== 1) throw new Error('only little-endian ELF is supported')

  const shoff = readU64(buffer, 0x28)
  const shentsize = buffer.readUInt16LE(0x3a)
  const shnum = buffer.readUInt16LE(0x3c)

  const sections = []
  for (let i = 0; i < shnum; i++) {
    const off = shoff + i * shentsize
    sections.push({
      type: buffer.readUInt32LE(off + 4),
      offset: readU64(buffer, off + 0x18),
      size: readU64(buffer, off + 0x20),
      link: buffer.readUInt32LE(off + 0x28)
    })
  }

  const SHT_DYNAMIC = 6
  const dynamic = sections.find((s) => s.type === SHT_DYNAMIC)
  if (!dynamic) throw new Error('no .dynamic section')
  const strtab = sections[dynamic.link]
  if (!strtab) throw new Error('dynamic section has no linked string table')

  const DT_NEEDED = 1
  const needed = []
  for (let pos = dynamic.offset; pos < dynamic.offset + dynamic.size; pos += 16) {
    const tag = readU64(buffer, pos)
    if (tag === 0) break
    if (tag !== DT_NEEDED) continue
    const strOff = strtab.offset + readU64(buffer, pos + 8)
    let end = strOff
    while (end < buffer.length && buffer[end] !== 0) end++
    needed.push(buffer.toString('utf8', strOff, end))
  }
  return needed
}

// Windows twin of the ELF reader: the DLL names in a PE32+ import table and
// delay-load import table (a delay-loaded vulkan-1.dll would still mean the
// GPU backend is linked into the addon). Enough for the prebuild artifacts
// this test inspects; not a general PE parser.
function peImports(buffer) {
  const isMz = buffer.length > 0x40 && buffer[0] === 0x4d && buffer[1] === 0x5a
  if (!isMz) throw new Error('not a PE file')
  const pe = buffer.readUInt32LE(0x3c)
  if (buffer.readUInt32LE(pe) !== 0x00004550) throw new Error('missing PE signature')
  const numberOfSections = buffer.readUInt16LE(pe + 6)
  const sizeOfOptionalHeader = buffer.readUInt16LE(pe + 20)
  const optional = pe + 24
  if (buffer.readUInt16LE(optional) !== 0x20b) throw new Error('only PE32+ is supported')

  const sections = []
  for (let i = 0; i < numberOfSections; i++) {
    const off = optional + sizeOfOptionalHeader + i * 40
    sections.push({
      virtualAddress: buffer.readUInt32LE(off + 12),
      sizeOfRawData: buffer.readUInt32LE(off + 16),
      pointerToRawData: buffer.readUInt32LE(off + 20)
    })
  }
  const rvaToOffset = (rva) => {
    const s = sections.find(
      (sec) => rva >= sec.virtualAddress && rva < sec.virtualAddress + sec.sizeOfRawData
    )
    if (!s) throw new Error('RVA outside every section: ' + rva)
    return rva - s.virtualAddress + s.pointerToRawData
  }

  const imports = []
  const readNames = (dirRva, descriptorSize, nameField) => {
    if (dirRva === 0) return
    for (let pos = rvaToOffset(dirRva); ; pos += descriptorSize) {
      const nameRva = buffer.readUInt32LE(pos + nameField)
      if (nameRva === 0) break
      const nameOff = rvaToOffset(nameRva)
      let end = nameOff
      while (end < buffer.length && buffer[end] !== 0) end++
      imports.push(buffer.toString('utf8', nameOff, end).toLowerCase())
    }
  }

  // PE32+ puts the data directory at optional header offset 112, preceded by
  // its entry count. Entry 1 is the import table (20-byte descriptors, name
  // at +12), entry 13 the delay-load import table (32-byte descriptors, name
  // at +4).
  const numberOfRvaAndSizes = buffer.readUInt32LE(optional + 108)
  const dirRva = (index) =>
    index < numberOfRvaAndSizes ? buffer.readUInt32LE(optional + 112 + index * 8) : 0
  readNames(dirRva(1), 20, 12)
  readNames(dirRva(13), 32, 4)
  return imports
}

// The Windows counterparts of FORBIDDEN_NEEDED and FORBIDDEN_RUNTIME: the
// addon must not import the Vulkan loader, and neither it nor the backend
// module may import the dynamic Visual C++ runtime (the prebuild links the
// static CRT, see vcpkg-overlays/triplets/x64-windows.cmake). A dynamic UCRT
// shows up as the api-ms-win-crt-* API sets, not as ucrtbase.dll.
const FORBIDDEN_WIN_IMPORTS = [
  'vulkan-1.dll',
  'opencl.dll',
  'nvcuda.dll',
  'cudart64',
  'cublas64',
  'cublaslt64'
]
const FORBIDDEN_WIN_RUNTIME = ['vcruntime', 'msvcp', 'ucrtbase.dll', 'api-ms-win-crt-']

test('win32 prebuild has no hard GPU-loader imports and ships the Vulkan backend DLL', async (t) => {
  if (os.platform() !== 'win32') {
    t.pass('PE import layout check is win32-only')
    return
  }
  if (proc.env && proc.env.QVAC_SKIP_PREBUILD_LINK_CHECK === 'true') {
    t.pass('QVAC_SKIP_PREBUILD_LINK_CHECK=true; skipping (custom local build)')
    return
  }

  const target = `${os.platform()}-${os.arch()}`
  const moduleName = moduleNameForHost(target)
  const addonPath = path.join(PREBUILDS_DIR, target, `${moduleName}.bare`)
  t.ok(fs.existsSync(addonPath), `prebuild present: ${addonPath}`)

  // 1. The addon must load on a host without a Vulkan runtime: no GPU loader
  //    and no dynamic CRT in its import table (QVAC-25560).
  const addonImports = peImports(fs.readFileSync(addonPath))
  t.comment(`${moduleName}.bare imports: ${addonImports.join(', ')}`)
  for (const dll of [...FORBIDDEN_WIN_IMPORTS, ...FORBIDDEN_WIN_RUNTIME]) {
    t.absent(
      addonImports.find((n) => n.startsWith(dll)),
      `addon must not import ${dll}* (breaks hosts without it)`
    )
  }

  // 2. GPU support must not silently disappear: the Vulkan backend has to
  //    ship as a runtime-loaded DLL next to the addon...
  const vulkanModulePath = path.join(
    PREBUILDS_DIR,
    target,
    moduleName,
    'qvac-diffusion-ggml-vulkan.dll'
  )
  t.ok(fs.existsSync(vulkanModulePath), `Vulkan DL backend module present: ${vulkanModulePath}`)

  // 3. ...and that DLL is where the vulkan-1.dll import belongs. It must be
  //    self-contained w.r.t. the CRT, or LoadLibrary fails on a stock host
  //    and the GPU never registers.
  const moduleImports = peImports(fs.readFileSync(vulkanModulePath))
  t.comment(`qvac-diffusion-ggml-vulkan.dll imports: ${moduleImports.join(', ')}`)
  t.ok(
    moduleImports.find((n) => n === 'vulkan-1.dll'),
    'Vulkan module imports vulkan-1.dll (loaded only when present at runtime)'
  )
  for (const dll of FORBIDDEN_WIN_RUNTIME) {
    t.absent(
      moduleImports.find((n) => n.startsWith(dll)),
      `Vulkan module must not import ${dll}* (LoadLibrary must work on stock hosts)`
    )
  }
})

test('linux prebuild has no hard GPU-loader deps and ships DL backend modules', async (t) => {
  if (os.platform() !== 'linux') {
    t.pass('dynamic-linking layout check is linux-only')
    return
  }
  if (proc.env && proc.env.QVAC_SKIP_PREBUILD_LINK_CHECK === 'true') {
    t.pass('QVAC_SKIP_PREBUILD_LINK_CHECK=true; skipping (custom local build)')
    return
  }

  const target = `${os.platform()}-${os.arch()}`
  const moduleName = moduleNameForHost(target)
  const addonPath = path.join(PREBUILDS_DIR, target, `${moduleName}.bare`)
  t.ok(fs.existsSync(addonPath), `prebuild present: ${addonPath}`)

  // 1. The addon itself must load on a host that has never had a graphics
  //    stack: no GPU userspace loader and no external C++ runtime in NEEDED.
  const addonNeeded = elfNeeded(fs.readFileSync(addonPath))
  t.comment(`${moduleName}.bare NEEDED: ${addonNeeded.join(', ')}`)
  for (const lib of [...FORBIDDEN_NEEDED, ...FORBIDDEN_RUNTIME]) {
    t.absent(
      addonNeeded.find((n) => n.startsWith(lib)),
      `addon must not hard-link ${lib}* (breaks CPU-only hosts)`
    )
  }

  // 2. GPU support must not silently disappear: the Vulkan backend has to
  //    ship as a dlopen'd module next to the addon...
  const vulkanModulePath = path.join(
    PREBUILDS_DIR,
    target,
    moduleName,
    'libqvac-diffusion-ggml-vulkan.so'
  )
  t.ok(fs.existsSync(vulkanModulePath), `Vulkan DL backend module present: ${vulkanModulePath}`)

  // 3. ...and that module is where the libvulkan dependency belongs. It must
  //    itself be self-contained w.r.t. the C++ runtime, or its dlopen fails
  //    silently on hosts without libc++ and the GPU never registers.
  const moduleNeeded = elfNeeded(fs.readFileSync(vulkanModulePath))
  t.comment(`libqvac-diffusion-ggml-vulkan.so NEEDED: ${moduleNeeded.join(', ')}`)
  t.ok(
    moduleNeeded.find((n) => n.startsWith('libvulkan.')),
    'Vulkan module links libvulkan (loaded only when present at runtime)'
  )
  for (const lib of FORBIDDEN_RUNTIME) {
    t.absent(
      moduleNeeded.find((n) => n.startsWith(lib)),
      `Vulkan module must not depend on ${lib}* (dlopen must work on stock distros)`
    )
  }
})

// File-level layout checks above prove the module EXISTS; this proves Linux
// and Windows can actually load and register it. A packaging mistake in the
// backends subdir, the module search path, or registration would pass the
// layout checks while GPU selection silently fell back to CPU. Backend
// registration is PROCESS-GLOBAL and happens on the first model load in the
// suite, so this test cannot rely on catching the one-time
// `load_backend: loaded Vulkan backend from ...` line — instead it requests
// `main-gpu: 0`, whose resolution walks the live ggml device registry on
// EVERY load and logs the resolved backend name: it can only resolve to
// Vulkan0 if the DL module actually registered (same log-capture pattern as
// main-gpu-backend.test.js). If registration broke, resolution falls back
// to CPU and the assertion fails.
test(
  'linux and win32 GPU hosts register the Vulkan backend through the DL module',
  { timeout: 600000 },
  async (t) => {
    if (os.platform() !== 'linux' && os.platform() !== 'win32') {
      t.pass('DL backend registration check is linux and win32 only')
      return
    }
    if (proc.env && proc.env.NO_GPU === 'true') {
      t.pass('NO_GPU=true; DL registration needs a GPU host')
      return
    }
    if (proc.env && proc.env.QVAC_SKIP_PREBUILD_LINK_CHECK === 'true') {
      t.pass('QVAC_SKIP_PREBUILD_LINK_CHECK=true; skipping (custom local build)')
      return
    }

    const binding = require('../../binding')
    const ImgStableDiffusion = require('../../index')
    const { ensureModel, releaseJsLogger } = require('./utils')

    const logs = []
    binding.setLogger((priority, message) => {
      logs.push(String(message))
    })

    let model = null
    try {
      const [modelName, modelDir] = await ensureModel({
        modelName: 'stable-diffusion-v2-1-Q8_0.gguf'
      })

      model = new ImgStableDiffusion({
        files: { model: path.join(modelDir, modelName) },
        config: {
          device: 'gpu',
          'main-gpu': 0,
          threads: 4,
          prediction: 'v',
          verbosity: 2
        },
        logger: console
      })
      await model.load()

      // The main-gpu resolver enumerates the live ggml device registry at
      // this load; on a Vulkan-capable host it can only report a Vulkan
      // backend if the DL module was loaded and registered. C++ log lines
      // are marshalled to the JS event loop asynchronously, so poll like
      // main-gpu-backend.test.js does instead of reading synchronously.
      const deadline = Date.now() + 5000
      let resolvedLine = null
      while (!resolvedLine && Date.now() < deadline) {
        resolvedLine = logs.find((line) => line.includes("main-gpu resolved to backend 'Vulkan"))
        if (!resolvedLine) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      t.ok(
        resolvedLine,
        `ggml device registry resolved a Vulkan backend (DL module registered): ${resolvedLine || 'NO MATCHING LOG LINE'}`
      )
    } finally {
      if (model) await model.unload().catch(() => {})
      releaseJsLogger(binding)
    }
  }
)
