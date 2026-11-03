#pragma once

#include <string>

#include <ggml-backend.h>

namespace classification_ggml {

// One compute device plus the CPU backend the scheduler falls back to. Both are
// owned; `cpu` equals `device` when the CPU itself was selected.
class GgmlBackends {
public:
  // `backend` is an exact ggml device name (CPU, CUDA0, Vulkan0, MTL0 or
  // Metal0); empty picks a GPU, then an integrated GPU, then the CPU.
  // `backendsDir` overrides where dynamic backends are loaded from. `who`
  // prefixes error messages.
  GgmlBackends(
      const std::string& backend, const std::string& backendsDir, int threads,
      const std::string& who);
  ~GgmlBackends();
  GgmlBackends(const GgmlBackends&) = delete;
  GgmlBackends& operator=(const GgmlBackends&) = delete;

  [[nodiscard]] ggml_backend_t device() const { return device_; }
  [[nodiscard]] ggml_backend_t cpu() const { return cpu_; }

private:
  ggml_backend_t device_ = nullptr;
  ggml_backend_t cpu_ = nullptr;
};

// Public backend ids reported in runtime stats: CPU=0, Metal=1, CUDA=2,
// Vulkan=3, OpenCL=4, other=99.
int backendId(const char* name);

} // namespace classification_ggml
