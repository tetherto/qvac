// Builds the browser (WebAssembly + WebGPU) prebuild into prebuilds/web.
// Fetches and verifies every source pinned in web/source-lock.json, then
// configures web/CMakeLists.txt with emcmake.
// Uses the Emscripten version pinned in the lock when it is on PATH, or
// installs that version into the build scratch directory. Requires cmake,
// ninja, Python, tar and unzip.
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
mkdirSync(scratch, { recursive: true })
// CMake compiler checks write probe artifacts into the working directory.
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', cwd: scratch, ...options })

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verify(path, expected) {
  const actual = sha256(path)
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${path}: ${actual} != ${expected}`)
  }
}

function copyNoticeTail(source, marker, destination) {
  const text = readFileSync(source, 'utf8')
  const start = text.lastIndexOf(marker)
  if (start < 0) throw new Error(`License marker not found in ${source}`)
  writeFileSync(destination, text.slice(start))
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
async function extract(name, source) {
  const archive = await download(source, `${name}-${source.sha256}.tar.gz`)
  const key = source.sha256.slice(0, 16)
  const dir = join(scratch, 'src', `${name}-${key}`, name)
  if (!existsSync(dir)) {
    const staging = `${dir}.staging`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    run('tar', ['-xzf', archive, '--strip-components=1', '-C', staging])
    renameSync(staging, dir)
  }
  return dir
}

function compilerVersion(command, env = process.env) {
  try {
    return execFileSync(command, ['--version'], { encoding: 'utf8', env }).split('\n')[0]
  } catch {
    return null
  }
}

function emscriptenRoot(command, env) {
  const searchDirs = execFileSync(command, ['-print-search-dirs'], { encoding: 'utf8', env })
  const match = searchDirs.match(/^libraries: =(.+?)[\\/]cache[\\/]sysroot[\\/]/m)
  if (!match) throw new Error(`Unable to locate the Emscripten installation from ${command}`)
  return match[1]
}

async function emscripten() {
  const active = compilerVersion('emcc')
  if (active?.includes(` ${lock.emscripten.version} `)) {
    return {
      emcc: 'emcc',
      emcmake: 'emcmake',
      env: process.env,
      root: emscriptenRoot('emcc', process.env),
      version: active
    }
  }

  const emsdk = await extract('emsdk', lock.emscripten)
  const emcc = join(emsdk, 'upstream', 'emscripten', 'emcc')
  const emcmake = join(emsdk, 'upstream', 'emscripten', 'emcmake')
  const env = { ...process.env, EM_CONFIG: join(emsdk, '.emscripten'), EMSDK: emsdk }
  let version = compilerVersion(emcc, env)
  if (!version?.includes(` ${lock.emscripten.version} `)) {
    run('python3', [join(emsdk, 'emsdk.py'), 'install', lock.emscripten.version], {
      cwd: emsdk,
      env
    })
    run('python3', [join(emsdk, 'emsdk.py'), 'activate', lock.emscripten.version], {
      cwd: emsdk,
      env
    })
    version = compilerVersion(emcc, env)
  }
  if (!version?.includes(` ${lock.emscripten.version} `)) {
    throw new Error(
      `Expected Emscripten ${lock.emscripten.version}, got: ${version ?? active ?? 'not found'}`
    )
  }
  return { emcc, emcmake, env, root: join(emsdk, 'upstream', 'emscripten'), version }
}

const compiler = await emscripten()
const fabric = await extract('fabric', lock.fabric)
const picojson = await extract('picojson', lock.picojson)
const concurrentqueue = await extract('concurrentqueue', lock.concurrentqueue)
const dawnArchive = await download(lock.dawn, `dawn-${lock.dawn.sha256}.zip`)
const dawn = join(scratch, 'src', `dawn-${lock.dawn.sha256.slice(0, 16)}`)
if (!existsSync(dawn)) {
  rmSync(`${dawn}.staging`, { recursive: true, force: true })
  run('unzip', ['-q', dawnArchive, '-d', `${dawn}.staging`])
  renameSync(`${dawn}.staging`, dawn)
}

const VARIANTS = [
  { name: 'llm-llamacpp', memory64: 'OFF' },
  { name: 'llm-llamacpp-64', memory64: 'ON' }
]
const jobs = process.env.QVAC_BUILD_JOBS ?? '4'
if (!/^[1-9]\d*$/.test(jobs)) throw new Error('QVAC_BUILD_JOBS must be a positive integer')
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
for (const variant of VARIANTS) {
  const build = join(scratch, `cmake-${variant.name}`)
  run(
    compiler.emcmake,
    [
      'cmake',
      '-S',
      web,
      '-B',
      build,
      '-G',
      'Ninja',
      '-DCMAKE_BUILD_TYPE=Release',
      `-DQVAC_WASM_MEMORY64=${variant.memory64}`,
      `-DFABRIC_SOURCE_DIR=${fabric}`,
      `-DEMDAWNWEBGPU_DIR=${join(dawn, 'emdawnwebgpu_pkg')}`,
      `-DPICOJSON_DIR=${picojson}`,
      `-DCONCURRENTQUEUE_DIR=${concurrentqueue}`,
      `-DINFERENCE_ADDON_CPP_DIR=${resolve(root, '../inference-addon-cpp/src')}`,
      `-DOUTPUT_DIR=${output}`
    ],
    { env: compiler.env }
  )
  run('cmake', ['--build', build, '--target', 'llm-llamacpp', '--parallel', jobs], {
    env: compiler.env
  })
}

const licenses = join(output, 'licenses')
mkdirSync(licenses, { recursive: true })
copyFileSync(join(fabric, 'LICENSE'), join(licenses, 'fabric.txt'))
cpSync(join(fabric, 'licenses'), join(licenses, 'fabric-third-party'), { recursive: true })
copyFileSync(join(dawn, 'emdawnwebgpu_pkg/webgpu/src/LICENSE'), join(licenses, 'dawn-webgpu.txt'))
copyFileSync(
  join(dawn, 'emdawnwebgpu_pkg/webgpu_cpp/LICENSE'),
  join(licenses, 'dawn-webgpu-cpp.txt')
)
copyFileSync(join(picojson, 'LICENSE'), join(licenses, 'picojson.txt'))
copyFileSync(join(concurrentqueue, 'LICENSE.md'), join(licenses, 'concurrentqueue.txt'))
copyFileSync(join(fabric, 'vendor/cpp-httplib/LICENSE'), join(licenses, 'fabric-cpp-httplib.txt'))
copyFileSync(join(fabric, 'vendor/hash/xxhash/LICENSE'), join(licenses, 'fabric-xxhash.txt'))
copyFileSync(join(fabric, 'vendor/hash/sha256/LICENSE'), join(licenses, 'fabric-sha256.txt'))
copyFileSync(
  join(fabric, 'vendor/hash/rotate-bits/LICENSE.md'),
  join(licenses, 'fabric-rotate-bits.txt')
)
copyNoticeTail(
  join(fabric, 'vendor/miniaudio/miniaudio.h'),
  'This software is available as a choice of the following licenses.',
  join(licenses, 'fabric-miniaudio.txt')
)
copyNoticeTail(
  join(fabric, 'vendor/stb/stb_image.h'),
  'This software is available under 2 licenses -- choose whichever you prefer.',
  join(licenses, 'fabric-stb-image.txt')
)
copyFileSync(join(compiler.root, 'LICENSE'), join(licenses, 'emscripten.txt'))
copyFileSync(
  join(compiler.root, 'system/lib/libc/musl/COPYRIGHT'),
  join(licenses, 'emscripten-musl.txt')
)
copyFileSync(
  join(compiler.root, 'system/lib/libcxx/LICENSE.TXT'),
  join(licenses, 'emscripten-libcxx.txt')
)
copyFileSync(
  join(compiler.root, 'system/lib/libcxxabi/LICENSE.TXT'),
  join(licenses, 'emscripten-libcxxabi.txt')
)
copyFileSync(
  join(compiler.root, 'system/lib/compiler-rt/LICENSE.TXT'),
  join(licenses, 'emscripten-compiler-rt.txt')
)

writeFileSync(
  join(output, 'build-manifest.json'),
  `${JSON.stringify(
    {
      ...lock,
      compiler: compiler.version,
      variants: Object.fromEntries(
        VARIANTS.map(({ name }) => [
          name,
          {
            wasmSha256: sha256(join(output, `${name}.wasm`)),
            moduleSha256: sha256(join(output, `${name}.mjs`))
          }
        ])
      )
    },
    null,
    2
  )}\n`
)
console.log(`Browser prebuild written to ${output}`)
