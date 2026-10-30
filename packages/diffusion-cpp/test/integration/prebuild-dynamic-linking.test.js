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

// Minimal ELF64 reader for dependencies and required C++ runtime symbols.
// Keep in sync with scripts/verify-prebuild-linking.mjs (a standalone CI script).
function elfInfo(buffer) {
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
      link: buffer.readUInt32LE(off + 0x28),
      entrySize: readU64(buffer, off + 0x38)
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

  // Strong undefined C++ runtime symbols still break dlopen when no runtime
  // appears in DT_NEEDED. Node can mask this by already loading libstdc++.
  // Weak references may legitimately remain unresolved. These three __cxa
  // entry points belong to glibc, not to a separately shipped C++ runtime.
  const glibcCxa = new Set(['__cxa_atexit', '__cxa_finalize', '__cxa_thread_atexit_impl'])
  const cxxRuntime =
    /^(?:_Z(?:N[KVR]*(?:St|S[a-z]|10__cxxabiv1)|St|T[ISV](?:St|N10__cxxabiv1)|n[aw]|d[al])|__cxa_|__gxx_personality_v0)/
  const symbols = sections.find((section) => section.type === 11) // SHT_DYNSYM
  if (!symbols || symbols.entrySize !== 24 || symbols.size % 24 !== 0) {
    throw new Error('missing or invalid .dynsym section')
  }
  const symbolNames = sections[symbols.link]
  if (!symbolNames) throw new Error('no dynamic symbol string table')
  const unresolvedCxx = []
  for (let off = symbols.offset; off < symbols.offset + symbols.size; off += 24) {
    const binding = buffer[off + 4] >> 4
    const sectionIndex = buffer.readUInt16LE(off + 6)
    if (binding !== 1 || sectionIndex !== 0) continue // STB_GLOBAL, SHN_UNDEF
    const nameOffset = symbolNames.offset + buffer.readUInt32LE(off)
    const end = buffer.indexOf(0, nameOffset)
    if (end < nameOffset || end >= symbolNames.offset + symbolNames.size) {
      throw new Error('invalid dynamic symbol name')
    }
    const name = buffer.toString('utf8', nameOffset, end)
    if (!cxxRuntime.test(name)) continue
    if (glibcCxa.has(name) && needed.includes('libc.so.6')) continue
    unresolvedCxx.push(name)
  }
  return { needed, unresolvedCxx }
}

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
  const { needed: addonNeeded, unresolvedCxx: addonUnresolvedCxx } = elfInfo(
    fs.readFileSync(addonPath)
  )
  t.alike(addonUnresolvedCxx, [], 'addon has no unresolved C++ runtime symbols')
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
  const { needed: moduleNeeded, unresolvedCxx: moduleUnresolvedCxx } = elfInfo(
    fs.readFileSync(vulkanModulePath)
  )
  t.alike(moduleUnresolvedCxx, [], 'Vulkan module has no unresolved C++ runtime symbols')
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

  const cudaPath = path.join(PREBUILDS_DIR, target, moduleName, 'libqvac-diffusion-ggml-cuda.so')
  const requireCuda = proc.env.CI === 'true' || proc.env.QVAC_REQUIRE_CUDA_MODULE === 'true'
  if (!fs.existsSync(cudaPath)) {
    if (requireCuda) t.fail(`CUDA DL backend module missing: ${cudaPath}`)
    else t.comment('CUDA module not built (SD_CUDA=OFF); skipping CUDA checks')
    return
  }
  t.pass(`CUDA DL backend module present: ${cudaPath}`)
  const { needed: cudaNeeded, unresolvedCxx: cudaUnresolvedCxx } = elfInfo(
    fs.readFileSync(cudaPath)
  )
  t.alike(cudaUnresolvedCxx, [], 'CUDA module has no unresolved C++ runtime symbols')
  t.comment(`libqvac-diffusion-ggml-cuda.so NEEDED: ${cudaNeeded.join(', ')}`)
  t.ok(
    cudaNeeded.find((n) => n.startsWith('libcudart.')),
    'CUDA module links libcudart'
  )
  for (const lib of FORBIDDEN_RUNTIME) {
    t.absent(
      cudaNeeded.find((n) => n.startsWith(lib)),
      `CUDA module must not depend on ${lib}*`
    )
  }
})

// File-level layout checks above prove the module EXISTS; this proves Linux
// can actually dlopen and register it. A packaging mistake in the backends
// subdir, the dlopen search path, or module registration would pass the
// layout checks while GPU selection silently fell back to CPU. Backend
// registration is PROCESS-GLOBAL and happens on the first model load in the
// suite, so this test cannot rely on catching the one-time
// `load_backend: loaded Vulkan backend from ...` line — instead it requests
// `backend: 'vulkan0'`, which requires that named backend to be registered.
// Device index zero may be CUDA on a Linux release, so it is not a stable
// way to select Vulkan. An unavailable explicit backend fails model load.
test(
  'linux GPU host registers the Vulkan backend through the DL module',
  { timeout: 600000 },
  async (t) => {
    if (os.platform() !== 'linux') {
      t.pass('DL backend registration check is linux-only')
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
          backend: 'vulkan0',
          threads: 4,
          prediction: 'v',
          verbosity: 2
        },
        logger: console
      })
      await model.load()

      // Successful load with an explicit Vulkan assignment proves the
      // registered device is usable. The assignment is also logged by the
      // addon, with C++ messages marshalled asynchronously to JS.
      const deadline = Date.now() + 5000
      let resolvedLine = null
      while (!resolvedLine && Date.now() < deadline) {
        resolvedLine = logs.find((line) =>
          line.includes("Explicit stable-diffusion backend assignment 'vulkan0'")
        )
        if (!resolvedLine) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      t.ok(
        resolvedLine,
        `explicit Vulkan backend loaded (DL module registered): ${resolvedLine || 'NO MATCHING LOG LINE'}`
      )
    } finally {
      if (model) await model.unload().catch(() => {})
      releaseJsLogger(binding)
    }
  }
)
