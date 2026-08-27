'use strict'

const path = require('bare-path')
const os = require('bare-os')
const fs = require('bare-fs')
const proc = require('bare-process')
const test = require('brittle')

const PREBUILDS_DIR = path.resolve(__dirname, '../../prebuilds')
const MODULE_NAME = 'qvac__diffusion-cpp'

// GPU userspace loaders that must never be a hard DT_NEEDED of the addon
// module itself: a CPU-only server has none of them installed, and a hard
// link makes the whole worker abort at addon load (QVAC-23767 / gh#3853).
const FORBIDDEN_NEEDED = ['libvulkan.', 'libOpenCL.', 'libcuda.', 'libcudart.']

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
  const addonPath = path.join(PREBUILDS_DIR, target, `${MODULE_NAME}.bare`)
  t.ok(fs.existsSync(addonPath), `prebuild present: ${addonPath}`)

  // 1. The addon itself must load on a host that has never had a graphics
  //    stack: no GPU userspace loader and no external C++ runtime in NEEDED.
  const addonNeeded = elfNeeded(fs.readFileSync(addonPath))
  t.comment(`${MODULE_NAME}.bare NEEDED: ${addonNeeded.join(', ')}`)
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
    MODULE_NAME,
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
// can actually dlopen and register it. A packaging mistake in the backends
// subdir, the dlopen search path, or module registration would pass the
// layout checks while GPU selection silently fell back to CPU — so on the
// linux GPU legs, load a model on device 'gpu' and require the ggml dynamic
// loader to report our shipped Vulkan module (same log-capture pattern as
// main-gpu-backend.test.js).
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
          threads: 4,
          prediction: 'v',
          verbosity: 2,
          backendsDir: PREBUILDS_DIR
        },
        logger: console
      })
      await model.load()

      // ggml-backend-reg logs `load_backend: loaded <name> backend from <path>`
      // for every module it dlopens; require the Vulkan one to come from our
      // shipped module directory, proving dlopen + registration end-to-end.
      const loaderLine = logs.find(
        (line) =>
          line.includes('load_backend') &&
          line.includes('loaded Vulkan backend from') &&
          line.includes(MODULE_NAME)
      )
      t.ok(
        loaderLine,
        `ggml loader registered the shipped Vulkan module: ${loaderLine || 'NO MATCHING LOG LINE'}`
      )
    } finally {
      if (model) await model.unload().catch(() => {})
      releaseJsLogger(binding)
    }
  }
)
