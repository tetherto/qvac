#!/usr/bin/env node
// fabric's linux-arm64 Jetson module, as main's prebuild built it after the CUDA 13 module: the CUDA 12 toolkit that
// setup-cuda left at QVAC_CUDA_JETSON_PATH for this command only, a second build tree with QVAC_CUDA_JETSON on, then
// exactly one CUDA 13 module and one Jetson module in the prebuilds.
//
//   node ci/build-jetson.mjs --platform=linux --arch=arm64

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const BUILD = 'build-cuda12'

// The CUDA variables setup-cuda exports, pointed at the Jetson toolkit; the vcpkg keep-list already names them.
export function jetsonEnv(base, prefix, version) {
  return {
    ...base,
    CUDA_PATH: prefix,
    CUDACXX: join(prefix, 'bin', 'nvcc'),
    QVAC_CUDA_TOOLKIT: `${version}-jetson`,
    PATH: [join(prefix, 'bin'), base.PATH].filter(Boolean).join(delimiter),
    LD_LIBRARY_PATH: [join(prefix, 'lib'), base.LD_LIBRARY_PATH].filter(Boolean).join(delimiter)
  }
}

// One file per pattern under prebuilds/<host>/<module dir>/, as main's check globbed it.
export function modules(prebuilds, host) {
  const dir = join(prebuilds, host)
  const found = { server: [], jetson: [] }
  if (!existsSync(dir)) return found
  const subs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const sub of subs) {
    for (const file of readdirSync(join(dir, sub.name))) {
      if (file.endsWith('ggml-cuda-jetson.so')) found.jetson.push(join(sub.name, file))
      else if (file.endsWith('ggml-cuda.so')) found.server.push(join(sub.name, file))
    }
  }
  return found
}

function run(args, env) {
  const r = spawnSync('pnpm', ['exec', 'bare-make', ...args], { cwd: PKG, env, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prefix = process.env.QVAC_CUDA_JETSON_PATH
  if (!prefix) {
    throw new Error('QVAC_CUDA_JETSON_PATH is unset; the configuration needs ci.setup cuda-jetson')
  }
  const nx = JSON.parse(readFileSync(join(PKG, '../../nx.json'), 'utf8'))
  const version = nx.targetDefaults.build.metadata.toolchain.cudaJetson
  const env = jetsonEnv(process.env, prefix, version)
  const flags = process.argv.slice(2)
  const defines = ['-D', 'BUILD_TESTING=OFF', '-D', 'QVAC_CUDA_JETSON=ON']
  run(['generate', '--build', BUILD, ...flags, ...defines], env)
  run(['build', '--build', BUILD], env)
  run(['install', '--build', BUILD], env)
  const found = modules(join(PKG, 'prebuilds'), 'linux-arm64')
  if (found.server.length !== 1) {
    throw new Error(`expected one CUDA 13 arm64 module, found ${found.server.length}`)
  }
  if (found.jetson.length !== 1) {
    throw new Error(`expected one CUDA 12 Jetson module, found ${found.jetson.length}`)
  }
  console.log(`CUDA 13 module: ${found.server[0]}\nJetson module: ${found.jetson[0]}`)
}
