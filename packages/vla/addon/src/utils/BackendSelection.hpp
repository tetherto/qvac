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

// Pick the best GPU device available, applying the Adreno gate:
//
//   Any Adreno       -> reject (driver-level matmul/dequant produces
//                                numerically incorrect ggml output —
//                                Samsung S25 Ultra Adreno 830 measured at
//                                cos sim 0.73 vs PyTorch on LIBERO real
//                                fixture, vs >0.999 on every other accepted
//                                Vulkan target. Caller falls back to CPU.)
//   Non-Adreno GPU   -> accept (Vulkan on desktop / Mali, Metal on Apple)
//
// Returns nullptr if no acceptable GPU exists; the caller should then init
// the CPU backend.
ggml_backend_dev_t pickBestGpuDevice();

} // namespace vla_backend_selection
