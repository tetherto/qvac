// Header-only fit check. Runs under Bare: as a desktop CLI, or imported by the
// custom-fit-stub-plugin handler inside the SDK worker on a phone.
//
// Given a full GGUF on disk it:
//   1. finds the data offset by walking the header (KV pairs + tensor infos)
//   2. writes a stub: the header bytes, then ftruncate to the full length
//   3. reports whether the filesystem made the stub sparse (allocated bytes)
//   4. runs @qvac/model-fit on the full file and on the stub, compares the plans
//   5. deletes the stub
//
// Metro also parses this file for the React Native side of the e2e app, so it
// must stay Hermes-safe: no top-level await, no import.meta, and the Bare-only
// modules are loaded lazily so importing this file has no side effects.
//
// CLI: bare check.mjs /abs/path/model.gguf [nCtx] [backendsDir]

const GGUF_MAGIC = 0x46554747 // "GGUF" little-endian
const SIZES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }

function unwrap(mod) {
  return mod && mod.default && typeof mod.default === 'object' ? mod.default : mod
}

async function loadDeps() {
  const [fsMod, pathMod, fitMod] = await Promise.all([
    import('bare-fs'),
    import('bare-path'),
    import('@qvac/model-fit')
  ])
  return { fs: unwrap(fsMod), path: unwrap(pathMod), modelFit: unwrap(fitMod) }
}

export function readHeaderOffsets(fs, fd) {
  let buf = Buffer.alloc(0)
  let filePos = 0
  let pos = 0
  const ensure = (n) => {
    while (pos + n > buf.length) {
      const chunk = Buffer.alloc(1 << 20)
      const read = fs.readSync(fd, chunk, 0, chunk.length, filePos)
      if (read === 0) throw new Error('unexpected EOF while reading GGUF header')
      filePos += read
      buf = Buffer.concat([buf, chunk.subarray(0, read)])
    }
  }
  const u32 = () => {
    ensure(4)
    const v = buf.readUInt32LE(pos)
    pos += 4
    return v
  }
  const u64 = () => {
    ensure(8)
    const v = Number(buf.readBigUInt64LE(pos))
    pos += 8
    return v
  }
  const str = () => {
    const n = u64()
    ensure(n)
    const s = buf.toString('utf8', pos, pos + n)
    pos += n
    return s
  }
  const skipValue = (t) => {
    if (t === 8) {
      str()
      return
    }
    if (t === 9) {
      const et = u32()
      const n = u64()
      for (let i = 0; i < n; i++) skipValue(et)
      return
    }
    const s = SIZES[t]
    if (s === undefined) throw new Error(`unknown GGUF value type ${t}`)
    ensure(s)
    pos += s
  }

  if (u32() !== GGUF_MAGIC) throw new Error('not a GGUF file')
  const version = u32()
  const nTensors = u64()
  const nKv = u64()
  let alignment = 32
  let tokenizerKv = 0
  for (let i = 0; i < nKv; i++) {
    const key = str()
    const type = u32()
    if (key === 'general.alignment') {
      ensure(4)
      alignment = buf.readUInt32LE(pos)
    }
    if (key.startsWith('tokenizer.')) tokenizerKv++
    skipValue(type)
  }
  const tensorInfoStart = pos
  for (let i = 0; i < nTensors; i++) {
    str()
    const nd = u32()
    ensure(8 * nd + 4 + 8)
    pos += 8 * nd + 4 + 8
  }
  const headerEnd = pos
  const dataOffset = Math.ceil(headerEnd / alignment) * alignment
  return {
    version,
    nTensors,
    nKv,
    tokenizerKv,
    tensorInfoBytes: headerEnd - tensorInfoStart,
    headerEnd,
    dataOffset
  }
}

function copyPrefix(fs, srcFd, dstPath, length) {
  const out = fs.openSync(dstPath, 'w')
  try {
    const chunk = Buffer.alloc(1 << 20)
    let copied = 0
    while (copied < length) {
      const want = Math.min(chunk.length, length - copied)
      const read = fs.readSync(srcFd, chunk, 0, want, copied)
      if (read === 0) throw new Error('short read while copying header')
      fs.writeSync(out, chunk, 0, read)
      copied += read
    }
    return out
  } catch (e) {
    fs.closeSync(out)
    throw e
  }
}

function allocatedBytes(st) {
  // st_blocks is in 512-byte units on every POSIX libuv target.
  return typeof st.blocks === 'number' && st.blocks > 0 ? st.blocks * 512 : null
}

function planFields(r) {
  if (!r) return null
  return {
    status: r.status,
    fits: r.fits,
    reason: r.reason,
    nGpuLayers: r.nGpuLayers,
    nCtx: r.nCtx,
    nBatch: r.nBatch,
    nUbatch: r.nUbatch,
    splitMode: r.splitMode,
    mainGpu: r.mainGpu,
    typeK: r.typeK,
    typeV: r.typeV,
    flashAttnType: r.flashAttnType,
    tensorSplit: r.tensorSplit,
    buftOverrides: Array.isArray(r.buftOverrides) ? r.buftOverrides.length : r.buftOverrides,
    nDevices: r.nDevices,
    nGpuDevices: r.nGpuDevices
  }
}

function platformTag() {
  if (typeof Bare !== 'undefined') return `${Bare.platform}-${Bare.arch}`
  return `${process.platform}-${process.arch}`
}

// Statically linked prebuilds (iOS, macOS, Windows) need no backends directory.
// Where backends ship as shared libraries (Android, Linux) the caller passes it
// explicitly; the report echoes what was used.
export async function runFitStubCheck({
  modelPath,
  nCtx = 4096,
  marginMiB = 1024,
  backendsDir,
  stubDir
} = {}) {
  const report = {
    platform: platformTag(),
    modelPath,
    nCtx,
    marginMiB,
    header: null,
    stub: null,
    fit: null,
    errors: {}
  }
  const t0 = Date.now()
  const finish = () => {
    report.totalMs = Date.now() - t0
    report.verdict = {
      sparseOk: !!report.stub && report.stub.sparse === true,
      stubLoads: !!(report.fit && report.fit.stub) && !report.errors.fitStub,
      planIdentical: !!(report.fit && report.fit.identical === true),
      pass: !!(
        report.stub &&
        report.stub.sparse === true &&
        report.fit &&
        report.fit.identical === true
      )
    }
    return report
  }

  let deps
  try {
    deps = await loadDeps()
  } catch (e) {
    report.errors.loadDeps = String((e && e.stack) || e)
    return finish()
  }
  const { fs, path, modelFit } = deps

  let srcFd = null
  let stubFd = null
  let stubPath = null
  try {
    srcFd = fs.openSync(modelPath, 'r')
    const fullSize = fs.fstatSync(srcFd).size
    const dir = stubDir || path.dirname(modelPath)
    stubPath = path.join(dir, `${path.basename(modelPath)}.fitstub-${Date.now()}.gguf`)

    report.header = Object.assign(readHeaderOffsets(fs, srcFd), { fullSize })

    stubFd = copyPrefix(fs, srcFd, stubPath, report.header.dataOffset)
    fs.ftruncateSync(stubFd, fullSize)
    fs.closeSync(stubFd)
    stubFd = null
    const st = fs.statSync(stubPath)
    const alloc = allocatedBytes(st)
    report.stub = {
      path: stubPath,
      apparentSize: st.size,
      allocatedBytes: alloc,
      // sparse if the filesystem allocated little more than the header we actually wrote
      sparse:
        alloc === null
          ? 'unknown (no st_blocks)'
          : alloc < report.header.dataOffset * 2 + (1 << 20),
      apparentMatchesFull: st.size === fullSize
    }

    const fitParams = modelFit && modelFit.fitParams
    if (typeof fitParams !== 'function') {
      report.errors.requireModelFit = 'fitParams not exported by @qvac/model-fit'
      return finish()
    }
    const opts = Object.assign(
      { nCtx, nCtxMin: nCtx, marginMiB },
      backendsDir ? { backendsDir } : {}
    )
    report.fit = {
      backendsDir: backendsDir || null,
      full: null,
      stub: null,
      identical: null,
      ms: {}
    }
    try {
      const a = Date.now()
      report.fit.full = planFields(fitParams(Object.assign({ modelPath }, opts)))
      report.fit.ms.full = Date.now() - a
    } catch (e) {
      report.errors.fitFull = String((e && e.stack) || e)
    }
    try {
      const a = Date.now()
      report.fit.stub = planFields(fitParams(Object.assign({ modelPath: stubPath }, opts)))
      report.fit.ms.stub = Date.now() - a
    } catch (e) {
      report.errors.fitStub = String((e && e.stack) || e)
    }
    if (report.fit.full && report.fit.stub) {
      report.fit.identical = JSON.stringify(report.fit.full) === JSON.stringify(report.fit.stub)
    }
    return finish()
  } catch (e) {
    report.errors.fatal = String((e && e.stack) || e)
    return finish()
  } finally {
    if (stubFd !== null) {
      try {
        fs.closeSync(stubFd)
      } catch {}
    }
    if (stubPath) {
      try {
        fs.unlinkSync(stubPath)
      } catch {}
    }
    if (srcFd !== null) {
      try {
        fs.closeSync(srcFd)
      } catch {}
    }
  }
}

// CLI entry: bare check.mjs <model.gguf> [nCtx] [backendsDir]
if (
  typeof Bare !== 'undefined' &&
  Array.isArray(Bare.argv) &&
  /check\.mjs$/.test(Bare.argv[1] || '')
) {
  const [, , modelPath, nCtxArg, backendsDir] = Bare.argv
  if (!modelPath) {
    console.error('usage: bare check.mjs <model.gguf> [nCtx] [backendsDir]')
    Bare.exitCode = 2
  } else {
    runFitStubCheck({ modelPath, nCtx: nCtxArg ? Number(nCtxArg) : 4096, backendsDir }).then(
      (report) => {
        console.log(JSON.stringify(report, null, 2))
        Bare.exitCode = report.verdict.pass ? 0 : 1
      }
    )
  }
}
