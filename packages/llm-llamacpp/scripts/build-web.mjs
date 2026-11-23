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
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateWebPrebuild } from './validate-web-prebuild.mjs'

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

// Fetches one directory from a pinned monorepo commit without downloading the
// repository's unrelated package history or release assets.
function extractGitDirectory(name, source) {
  const dir = join(scratch, 'src', `${name}-${source.tree}`, name)
  if (existsSync(dir)) return dir

  const repository = join(scratch, 'git', `${name}-${source.commit}`)
  rmSync(repository, { recursive: true, force: true })
  mkdirSync(repository, { recursive: true })
  run('git', ['init', '--quiet'], { cwd: repository })
  run('git', ['fetch', '--quiet', '--depth=1', '--filter=blob:none', source.url, source.commit], {
    cwd: repository
  })
  const tree = execFileSync('git', ['rev-parse', `FETCH_HEAD:${source.subdir}`], {
    cwd: repository,
    encoding: 'utf8'
  }).trim()
  if (tree !== source.tree) {
    throw new Error(`Git tree mismatch for ${source.subdir}: ${tree} != ${source.tree}`)
  }

  const archive = join(scratch, 'downloads', `${name}-${source.tree}.tar`)
  mkdirSync(dirname(archive), { recursive: true })
  run('git', ['archive', '--format=tar', `--output=${archive}`, 'FETCH_HEAD', source.subdir], {
    cwd: repository
  })
  const staging = `${dir}.staging`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  run('tar', ['-xf', archive, '--strip-components=3', '-C', staging])
  renameSync(staging, dir)
  rmSync(repository, { recursive: true, force: true })
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

function emsdkEnvironment(emsdk, env) {
  const config = join(emsdk, '.emscripten')
  const contents = readFileSync(config, 'utf8')
  const match = contents.match(/^PYTHON = emsdk_path \+ ['"](.+)['"]$/m)
  return {
    ...env,
    PATH: match ? `${dirname(join(emsdk, match[1]))}${delimiter}${env.PATH ?? ''}` : env.PATH,
    EM_CONFIG: config,
    EMSDK: emsdk
  }
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
  let env = { ...process.env, EM_CONFIG: join(emsdk, '.emscripten'), EMSDK: emsdk }
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
    env = emsdkEnvironment(emsdk, env)
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
const inferenceAddonCpp = extractGitDirectory('inference-addon-cpp', lock.inferenceAddonCpp)
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
      `-DINFERENCE_ADDON_CPP_DIR=${inferenceAddonCpp}`,
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
validateWebPrebuild(root, output)
console.log(`Browser prebuild written to ${output}`)
