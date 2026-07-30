// @qvac/fabric is a "carrier" bare addon: its sole purpose is to host the
// qvac-fabric (forked llama.cpp + ggml) runtime as a single shared library
// (`qvac__fabric@0.bare`) that consumer addons dynamically link against. The
// llama / ggml / common / mtmd symbols are exported via the platform symbol
// map (symbols.map / exports.txt) so that exactly one copy of the runtime is
// loaded per process, regardless of how many fabric-based addons are present.
//
// There is intentionally no inference JS API here; consumers use the C++
// headers (llama.h, ggml.h, common, mtmd) shipped under prebuilds/include and
// resolve the implementation at runtime from this module.

#include <bare.h>
#include <js.h>

namespace {

js_value_t* qvacFabricExports(js_env_t* env, js_value_t* exports) {
  // No JS surface is exposed: the module exists only to carry the native
  // runtime symbols. Consumers `require('@qvac/fabric')` to register and load
  // this module before their own addon resolves `qvac__fabric@0.bare`.
  return exports;
}

}  // namespace

BARE_MODULE(qvac_fabric, qvacFabricExports)
