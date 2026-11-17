// Exercise the real native loader with tiny shared libraries in installed and
// flattened layouts. No GPU, model download or full Fabric build is needed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

test(
  'native discovery loads all package directories once and preserves the override',
  { skip: process.platform !== 'linux' },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-discovery-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const addon = path.resolve(__dirname, '../../addon')
    const include = path.resolve(__dirname, '../../include')
    const write = (file, content) => fs.writeFileSync(path.join(root, file), content)
    const run = (command, args, options = {}) => {
      const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
      assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout)
      return result.stdout.trim().split('\n')
    }
    write(
      'ggml-backend.h',
      '#include <stddef.h>\nvoid ggml_backend_load_all_from_path(const char*);\nvoid ggml_backend_load(const char*);\nsize_t ggml_backend_reg_count();\n'
    )
    write(
      'ggml.cpp',
      `#include <cstdio>
#include <atomic>
#include "ggml-backend.h"
static std::atomic<size_t> count{0};
void ggml_backend_load_all_from_path(const char* path) { ++count; std::puts(path); }
void ggml_backend_load(const char* path) { ++count; std::puts(path); }
size_t ggml_backend_reg_count() { return count; }
`
    )
    // Minimal Bare registration ABI: compile the actual carrier source and invoke
    // its exports callback, without linking an entire JavaScript engine.
    write(
      'bare.h',
      `struct js_env_t; struct js_value_t;
#define BARE_MODULE(id, fn) extern "C" js_value_t* bare_register_module_v0(js_env_t* env, js_value_t* exports) { return fn(env, exports); }
`
    )
    write(
      'main.cpp',
      `#include <dlfcn.h>
#include <thread>
#include <vector>
#include <cstdio>
#include "qvac-fabric.h"
int main(int argc, char** argv) {
  for (int i = 1; i < argc; ++i) {
    void* handle = dlopen(argv[i], RTLD_NOW | RTLD_LOCAL);
    if (!handle) { std::fprintf(stderr, "%s\\n", dlerror()); return 1; }
    auto init = reinterpret_cast<void* (*)(void*, void*)>(dlsym(handle, "bare_register_module_v0"));
    if (!init) return 2;
    init(nullptr, nullptr);
    init(nullptr, nullptr); // repeated registration must not duplicate loads
  }
  std::vector<std::thread> threads;
  for (int i = 0; i < 8; ++i) threads.emplace_back([] { qvac_fabric_load_backends(); });
  for (auto& thread : threads) thread.join();
  std::printf("count=%zu\\n", qvac_fabric_load_backends());
}
`
    )
    const cxx = process.env.CXX || 'c++'
    const common = ['-std=c++20', '-I', root, '-I', include, '-I', addon, '-pthread']
    const installed = path.join(root, 'installed')
    const flat = path.join(root, 'flat')
    fs.mkdirSync(installed)
    fs.mkdirSync(flat)
    const runtimeDir = path.join(installed, 'base')
    fs.mkdirSync(path.join(runtimeDir, 'qvac__fabric-linux-x64'), { recursive: true })
    const runtime = path.join(runtimeDir, 'qvac__fabric-linux-x64.bare')
    run(cxx, [
      ...common,
      '-shared',
      '-fPIC',
      '-DQVAC_FABRIC_BUILD',
      '-DQVAC_FABRIC_MODULE_NAME="qvac__fabric-linux-x64"',
      path.join(addon, 'backends.cpp'),
      'ggml.cpp',
      '-Wl,-soname,qvac__fabric-linux-x64@0.bare',
      '-ldl',
      '-o',
      runtime
    ])
    // SONAME alias only needed by the standalone test executable's ELF loader.
    fs.symlinkSync(runtime, path.join(runtimeDir, 'qvac__fabric-linux-x64@0.bare'))
    const carriers = []
    for (const backend of ['cuda', 'hip']) {
      const name = 'qvac__fabric-linux-x64-' + backend
      const dir = path.join(installed, backend)
      fs.mkdirSync(path.join(dir, name), { recursive: true })
      const carrier = path.join(dir, name + '.bare')
      run(cxx, [
        ...common,
        '-shared',
        '-fPIC',
        '-DQVAC_FABRIC_MODULE_NAME="' + name + '"',
        '-DQVAC_FABRIC_BACKEND_FILE="libqvac-ggml-' + backend + '.so"',
        path.join(addon, 'backend-package.cpp'),
        runtime,
        '-o',
        carrier
      ])
      carriers.push(carrier)
    }
    run(cxx, [
      ...common,
      'main.cpp',
      runtime,
      '-Wl,-rpath,$ORIGIN',
      '-ldl',
      '-o',
      path.join(runtimeDir, 'test')
    ])
    const env = { ...process.env }
    delete env.QVAC_FABRIC_BACKENDS_DIR
    const output = run(path.join(runtimeDir, 'test'), carriers, { env })
    assert.deepEqual(output, [
      path.join(installed, 'cuda/qvac__fabric-linux-x64-cuda/libqvac-ggml-cuda.so'),
      path.join(installed, 'hip/qvac__fabric-linux-x64-hip/libqvac-ggml-hip.so'),
      path.join(runtimeDir, 'qvac__fabric-linux-x64'),
      'count=3'
    ])
    assert.deepEqual(
      run(path.join(runtimeDir, 'test'), carriers, {
        env: { ...env, QVAC_FABRIC_BACKENDS_DIR: '/explicit/backends' }
      }),
      ['/explicit/backends', 'count=1']
    )
    for (const file of [runtime, ...carriers, path.join(runtimeDir, 'test')]) {
      fs.copyFileSync(file, path.join(flat, path.basename(file)))
    }
    fs.symlinkSync('qvac__fabric-linux-x64.bare', path.join(flat, 'qvac__fabric-linux-x64@0.bare'))
    assert.deepEqual(
      run(
        path.join(flat, 'test'),
        carriers.map((file) => path.join(flat, path.basename(file))),
        { env }
      ),
      [flat, 'count=1']
    )
  }
)
