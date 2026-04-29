#pragma once

#include <string>

#include <ggml-backend.h>

namespace vla_backend_selection {

// Extract the Adreno model number from a device description string.
// Returns 0 for non-Adreno devices.
//
//   "Adreno (TM) 830" -> 830
//   "Adreno 740"      -> 740
//   "Mali-G715"       -> 0
int parseAdrenoModel(const std::string& description);

// Pick the best GPU device available, applying the Adreno < 800 gate:
//
//   Adreno 800+      -> accept
//   Adreno < 800     -> reject (driver bugs / unreliable on older Adreno;
//                                caller falls back to CPU)
//   Non-Adreno GPU   -> accept (Vulkan on desktop / Mali, Metal on Apple)
//
// Mirrors lib-infer-diffusion's `resolveBackendForDevice` and
// qvac-lib-infer-llamacpp-llm's `BackendSelection`. Returns nullptr if no
// acceptable GPU exists; the caller should then init the CPU backend.
ggml_backend_dev_t pickBestGpuDevice();

} // namespace vla_backend_selection
