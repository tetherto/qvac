// @qvac/fabric is a "carrier" bare addon: its sole purpose is to host the
// qvac-fabric (forked llama.cpp + ggml) runtime as a single shared library
// (`qvac__fabric-<suffix>@<major>.bare`, shipped by @qvac/fabric-<suffix>) that
// consumer addons dynamically link against. The llama / ggml / common / mtmd
// symbols are exported via the platform symbol map (symbols.map / exports.txt)
// so that exactly one copy of the runtime is loaded per process, regardless of
// how many fabric-based addons are present.
//
// There is intentionally no inference JS API here; consumers use the C++
// headers (llama.h, ggml.h, common, mtmd, qvac-fabric.h) shipped under
// prebuilds/include and resolve the implementation at runtime from this module.
// The JS surface is limited to backend discovery, for diagnostics and tests:
//
//   backendsDir()   -> string   qvac_fabric_backends_dir()
//   loadBackends()  -> number   qvac_fabric_load_backends()

#include <cstring>

#include <bare.h>
#include <js.h>

#include "qvac-fabric.h"

namespace {

js_value_t* backendsDir(js_env_t* env, js_callback_info_t* /*info*/) {
  const char* dir = qvac_fabric_backends_dir();
  js_value_t* result = nullptr;
  if (js_create_string_utf8(
          env, reinterpret_cast<const utf8_t*>(dir), std::strlen(dir), &result) !=
      0) {
    return nullptr;
  }
  return result;
}

js_value_t* loadBackends(js_env_t* env, js_callback_info_t* /*info*/) {
  const size_t count = qvac_fabric_load_backends();
  js_value_t* result = nullptr;
  if (js_create_uint32(env, static_cast<uint32_t>(count), &result) != 0) {
    return nullptr;
  }
  return result;
}

int exportFunction(
    js_env_t* env, js_value_t* exports, const char* name, js_function_cb cb) {
  js_value_t* fn = nullptr;
  int err = js_create_function(env, name, std::strlen(name), cb, nullptr, &fn);
  if (err != 0) return err;
  return js_set_named_property(env, exports, name, fn);
}

js_value_t* qvacFabricExports(js_env_t* env, js_value_t* exports) {
  // Consumers `require('@qvac/fabric')` to register and load this module before
  // their own addon resolves its DT_NEEDED on it.
  if (exportFunction(env, exports, "backendsDir", backendsDir) != 0) return nullptr;
  if (exportFunction(env, exports, "loadBackends", loadBackends) != 0) return nullptr;
  return exports;
}

}  // namespace

BARE_MODULE(qvac_fabric, qvacFabricExports)
