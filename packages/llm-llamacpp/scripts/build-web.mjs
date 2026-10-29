// Builds the browser (WebAssembly + WebGPU) prebuild into prebuilds/web.
// Fetches and verifies every source pinned in web/source-lock.json, applies
// web/patches to Fabric, then configures web/CMakeLists.txt with emcmake.
// Requires the Emscripten version pinned in the lock on PATH, plus cmake,
// ninja, tar, unzip and patch.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const web = join(root, 'web')
const lock = JSON.parse(readFileSync(join(web, 'source-lock.json'), 'utf8'))
const scratch = join(root, 'build', 'web')
const output = join(root, 'prebuilds', 'web')
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options })

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verify(path, expected) {
  const actual = sha256(path)
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${path}: ${actual} != ${expected}`)
  }
}

async function download(source, name) {
  const path = join(scratch, 'downloads', name)
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    const response = await fetch(source.url)
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${source.url}`)
    }
    writeFileSync(`${path}.part`, Buffer.from(await response.arrayBuffer()))
    renameSync(`${path}.part`, path)
  }
  verify(path, source.sha256)
  return path
}

// Extracts a tarball once per pinned digest so a changed lock never reuses a
// stale tree.
async function extract(name, source, patches = []) {
  const archive = await download(source, `${name}-${source.sha256}.tar.gz`)
  const key = createHash('sha256')
    .update(source.sha256)
    .update(JSON.stringify(patches))
    .digest('hex')
    .slice(0, 16)
  const dir = join(scratch, 'src', `${name}-${key}`, name)
  if (!existsSync(dir)) {
    const staging = `${dir}.staging`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    run('tar', ['-xzf', archive, '--strip-components=1', '-C', staging])
    for (const patch of patches) {
      run('patch', ['-p1', '--batch', '--fuzz=0', '--input', join(web, patch.path)], {
        cwd: staging
      })
    }
    renameSync(staging, dir)
  }
  return dir
}

for (const patch of lock.fabric.patches) verify(join(web, patch.path), patch.sha256)

const compiler = execFileSync('emcc', ['--version'], { encoding: 'utf8' }).split('\n')[0]
if (!compiler.includes(` ${lock.emscripten.version} `)) {
  throw new Error(`Expected Emscripten ${lock.emscripten.version}, got: ${compiler}`)
}

const fabric = await extract('fabric', lock.fabric, lock.fabric.patches)
const picojson = await extract('picojson', lock.picojson)
const concurrentqueue = await extract('concurrentqueue', lock.concurrentqueue)
const dawnArchive = await download(lock.dawn, `dawn-${lock.dawn.sha256}.zip`)
const dawn = join(scratch, 'src', `dawn-${lock.dawn.sha256.slice(0, 16)}`)
if (!existsSync(dawn)) {
  rmSync(`${dawn}.staging`, { recursive: true, force: true })
  run('unzip', ['-q', dawnArchive, '-d', `${dawn}.staging`])
  renameSync(`${dawn}.staging`, dawn)
}

const build = join(scratch, 'cmake')
mkdirSync(output, { recursive: true })
run('emcmake', [
  'cmake',
  '-S',
  web,
  '-B',
  build,
  '-G',
  'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
  `-DFABRIC_SOURCE_DIR=${fabric}`,
  `-DEMDAWNWEBGPU_DIR=${join(dawn, 'emdawnwebgpu_pkg')}`,
  `-DPICOJSON_DIR=${picojson}`,
  `-DCONCURRENTQUEUE_DIR=${concurrentqueue}`,
  `-DINFERENCE_ADDON_CPP_DIR=${resolve(root, '../inference-addon-cpp/src')}`,
  `-DOUTPUT_DIR=${output}`
])
const jobs = process.env.QVAC_BUILD_JOBS ?? '4'
if (!/^[1-9]\d*$/.test(jobs)) throw new Error('QVAC_BUILD_JOBS must be a positive integer')
run('cmake', ['--build', build, '--target', 'llm-llamacpp', '--parallel', jobs])

const licenses = join(output, 'licenses')
mkdirSync(licenses, { recursive: true })
copyFileSync(join(fabric, 'LICENSE'), join(licenses, 'fabric.txt'))
cpSync(join(fabric, 'licenses'), join(licenses, 'fabric-third-party'), { recursive: true })
copyFileSync(join(dawn, 'emdawnwebgpu_pkg/webgpu/src/LICENSE'), join(licenses, 'dawn-webgpu.txt'))
copyFileSync(join(picojson, 'LICENSE'), join(licenses, 'picojson.txt'))
copyFileSync(join(concurrentqueue, 'LICENSE.md'), join(licenses, 'concurrentqueue.txt'))

writeFileSync(
  join(output, 'build-manifest.json'),
  `${JSON.stringify(
    {
      ...lock,
      compiler,
      wasmSha256: sha256(join(output, 'llm-llamacpp.wasm')),
      moduleSha256: sha256(join(output, 'llm-llamacpp.mjs'))
    },
    null,
    2
  )}\n`
)
console.log(`Browser prebuild written to ${output}`)
