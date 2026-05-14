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
//   Adreno >= 800 + OpenCL -> accept (preferred Adreno path — Qualcomm /
//                                qvac-fabric's own ggml loader actively
//                                maintain OpenCL on Adreno > 700; integration
//                                test's cos-sim-vs-PyTorch assertion catches
//                                regressions)
//   Adreno >= 800 + Vulkan -> reject (Samsung S25 Ultra Adreno 830 measured
//                                cos 0.73 vs PyTorch on LIBERO real fixture,
//                                vs >0.999 on every other accepted Vulkan
//                                target)
//   Adreno <  800          -> reject (known Qualcomm OpenCL ICD issues on
//                                older generations: incomplete OpenCL 3.0,
//                                kernel-compile failures, shared-memory OOMs)
//   Non-Adreno GPU         -> accept (Vulkan on desktop / Mali, Metal on
//                                Apple)
//
// Returns nullptr if no acceptable GPU exists; the caller should then init
// the CPU backend.
ggml_backend_dev_t pickBestGpuDevice();

} // namespace vla_backend_selection
