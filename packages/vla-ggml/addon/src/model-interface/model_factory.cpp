#include "model-interface/model_factory.hpp"

#include <algorithm>
#include <cctype>
#include <stdexcept>

#include <ggml.h>
#include <gguf.h>

#include "model-interface/pi05.hpp"
#include "model-interface/smolvla_adapter.hpp"

namespace qvac_lib_infer_vla_ggml {

namespace {

// RAII guard for the sniff-time gguf_context. Distinct from the load path's
// RAII helper to keep the dependency surface here narrow (no smolvla.cpp
// internals).
struct GgufCloser {
  void operator()(gguf_context* g) const {
    if (g != nullptr) {
      gguf_free(g);
    }
  }
};
using GgufHandle = std::unique_ptr<gguf_context, GgufCloser>;

std::string toLowerAscii(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return s;
}

// Try to read a string-typed metadata key from a GGUF context. Returns an
// empty string if the key is missing or has a non-string type — the caller
// is responsible for the fallback chain.
std::string readGgufString(gguf_context* ctx, const char* key) {
  const int64_t idx = gguf_find_key(ctx, key);
  if (idx < 0) return {};
  if (gguf_get_kv_type(ctx, idx) != GGUF_TYPE_STRING) return {};
  const char* val = gguf_get_val_str(ctx, idx);
  return val != nullptr ? std::string(val) : std::string{};
}

} // namespace

std::string sniffGgufArchitecture(const std::string& ggufPath) {
  // Open with no_alloc=true so the second open during the real load path
  // is independent (no shared tensor data context). The metadata-only
  // open is cheap.
  struct ggml_context* ctxData = nullptr;
  struct gguf_init_params params {};
  params.no_alloc = true;
  params.ctx = &ctxData;

  GgufHandle handle(gguf_init_from_file(ggufPath.c_str(), params));
  if (!handle) {
    throw std::runtime_error(
        "sniffGgufArchitecture: failed to open GGUF file: " + ggufPath);
  }

  std::string arch = readGgufString(handle.get(), "general.architecture");
  if (arch.empty()) {
    // Be lenient: some early converters used `model_type`. Mirrors
    // llama.cpp's fallback chain in src/llama-model.cpp.
    arch = readGgufString(handle.get(), "model_type");
  }
  if (arch.empty()) {
    // Existing SmolVLA GGUFs predate the architecture key altogether —
    // default rather than reject so v0.1.0 weights keep loading.
    arch = "smolvla";
  }

  // Free the metadata-only ggml context. The real load path opens its own.
  if (ctxData != nullptr) {
    ggml_free(ctxData);
  }
  // GgufHandle destructor closes the sniff context here.
  return toLowerAscii(std::move(arch));
}

std::unique_ptr<IVlaModel> createVlaModelFromGguf(
    const std::string& ggufPath,
    bool forceCpu,
    const std::string& backendsDir) {
  const std::string arch = sniffGgufArchitecture(ggufPath);

  if (arch == "smolvla") {
    return std::make_unique<SmolvlaModelAdapter>(
        ggufPath, forceCpu, backendsDir);
  }
  if (arch == "pi05") {
    return std::make_unique<Pi05Model>(ggufPath, forceCpu, backendsDir);
  }

  throw std::runtime_error(
      "createVlaModelFromGguf: unsupported general.architecture='" + arch +
      "' (expected 'smolvla' or 'pi05')");
}

} // namespace qvac_lib_infer_vla_ggml
