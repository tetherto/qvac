#pragma once

#include <string>
#include <string_view>
#include <vector>

#include <ggml-backend.h>

namespace vla_backend_selection {

// Parse the GPU half of the `backend` config value into a lowercased priority
// list, e.g. "CUDA,Vulkan" -> {"cuda", "vulkan"}. QVAC-23763.
//
// "cpu" is NOT a family name here, unlike in llm-llamacpp and embed-llamacpp:
// those have a separate `device` key, vla does not, so the addon layer strips
// `backend: 'cpu'` into forceCpu before this is reached.
//
// An unknown NAME throws; a known name with no device attached is legitimate,
// e.g. cuda on a Vulkan-only host, and falls through to the next entry. "auto"
// is accepted and dropped, so it contributes no preference.
std::vector<std::string> parseBackendOverride(const std::string& backendStr);

// Extract the Adreno model number from a device description string.
// Returns 0 for non-Adreno devices.
//
//   "Adreno (TM) 830" -> 830
//   "Adreno 740"      -> 740
//   "Mali-G715"       -> 0
int parseAdrenoModel(const std::string& description);

/// @brief Whether a lowercased ggml device backend name belongs to a family.
/// Exposed for tests: the Metal spelling is the part worth pinning.
bool backendNameMatchesFamily(
    const std::string& lowercasedBackendName, std::string_view family);

// Discover and register ggml backend plugins (Vulkan / Metal / OpenCL / …).
// Thread-safe (std::call_once); safe to call from multiple model constructors.
// `backendsDir` is the absolute path to the prebuilds folder; BACKENDS_SUBDIR
// (set by CMake) is appended automatically on plugin-based targets.
void loadBackendsOnce(const std::string& backendsDir);

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
// Every other GPU or iGPU is accepted, ROCm, SYCL, non-Adreno OpenCL and RPC
// included. That set is wider than llm-llamacpp and embed-llamacpp on purpose:
// ROCm is the HIP Strix Halo target, which those addons do not ship.
//
// Among accepted devices the order is a discrete CUDA GPU, then HIP/ROCm, then
// the first discrete GPU, then an integrated CUDA GPU, then the first iGPU.
// CUDA first covers a mixed NVIDIA and AMD host only when the CUDA backend
// registers; an NVIDIA GPU seen only through Vulkan still loses to ROCm.
//
// `backendOverride`, when non-empty, restricts the choice to those families in
// priority order, then falls through to the normal order if none match. The
// Adreno gate above still applies and an override cannot bypass it.
//
// Returns nullptr if no acceptable GPU exists; the caller should then init
// the CPU backend.
ggml_backend_dev_t
pickBestGpuDevice(const std::vector<std::string>& backendOverride = {});

// The ggml device calls pickBestGpuDevice() makes, so tests can feed it a fake
// device list. The overload above passes the real ggml functions.
struct DeviceInterface {
  size_t (*devCount)();
  ggml_backend_dev_t (*devGet)(size_t index);
  enum ggml_backend_dev_type (*devType)(ggml_backend_dev_t device);
  const char* (*devName)(ggml_backend_dev_t device);
  const char* (*devDescription)(ggml_backend_dev_t device);
};

ggml_backend_dev_t pickBestGpuDevice(
    const DeviceInterface& devI,
    const std::vector<std::string>& backendOverride);

} // namespace vla_backend_selection
