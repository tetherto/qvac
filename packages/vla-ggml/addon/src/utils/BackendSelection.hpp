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

// Trailing marker parseBackendRequest appends when the list also named 'auto'.
inline constexpr std::string_view K_AUTO_FALLBACK = "auto";

// parseBackendOverride, plus K_AUTO_FALLBACK at the end when the list named
// 'auto' next to a GPU family, "auto,cuda" -> {"cuda", "auto"}. The loaders
// read the marker through backendOverrideIsStrict: a list with 'auto' in it
// keeps the CPU fallback, a list without it never ends on CPU.
std::vector<std::string> parseBackendRequest(const std::string& backendStr);

// True when the caller named GPU families and no 'auto', so the loaders must
// throw rather than fall back to CPU.
bool backendOverrideIsStrict(const std::vector<std::string>& backendOverride);

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
// `backendsDir` optionally names a directory holding the backend modules;
// empty loads the ones @qvac/fabric ships (qvac_fabric_load_backends()).
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
// Among accepted devices the order is CUDA, then HIP/ROCm, then the first
// discrete GPU, then the first iGPU. CUDA first covers a mixed NVIDIA and AMD
// host only when the CUDA backend registers; an NVIDIA GPU seen only through
// Vulkan still loses to ROCm.
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

// The override as the caller wrote it, "cuda,vulkan", for log and error text.
std::string
describeBackendOverride(const std::vector<std::string>& backendOverride);

// Why a loader could not honour a strict override (backendOverrideIsStrict).
enum class StrictGpuFailure { NoDevice, DeviceInitFailed, WeightLoadFailed };

// Error text the three loaders share for a strict override they refuse to
// run on CPU. `deviceName` is used only for WeightLoadFailed.
//
// PUBLIC ERROR-CODE CONTRACT: the text must not contain "backend: "
// (NATIVE_ERR_MARKERS.badBackend in src/index.ts), so the JS wrapper reports
// it as FAILED_TO_LOAD_WEIGHTS, as the docs promise.
std::string strictGpuRefusal(
    StrictGpuFailure failure, const std::vector<std::string>& backendOverride,
    const std::string& deviceName = "");

} // namespace vla_backend_selection
