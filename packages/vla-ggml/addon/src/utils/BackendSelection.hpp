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
//
// BEHAVIOUR CHANGE: any value other than "cpu" used to mean "pick the best
// device", so a typo went unnoticed. It now throws.
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
// Among accepted devices the order is CUDA, then HIP/ROCm, then anything else.
// QVAC-23763 puts CUDA ahead of HIP deliberately: the HIP preference below
// assumes a single AMD-GPU target and its own comment flags the mixed-vendor
// host as where it picks the wrong device. CUDA only appears on a discrete
// NVIDIA GPU, so preferring it resolves that case. AMD-only hosts still get
// HIP, since no CUDA device is present.
//
// `backendOverride`, when non-empty, restricts the choice to those families in
// priority order, then falls through to the normal order if none match. The
// Adreno gate above still applies and an override cannot bypass it.
//
// `backendRequired` makes that override binding: a list matching no accepted
// device throws instead of falling through. Without it the pin is advisory, so
// a caller that must not silently move backends has no way to say so.
// QVAC-23763. Note the Adreno gate can be the reason a device is not in the
// accepted list at all, so the error names what was accepted.
//
// Returns nullptr if no acceptable GPU exists; the caller should then init
// the CPU backend.
ggml_backend_dev_t pickBestGpuDevice(
    const std::vector<std::string>& backendOverride = {},
    bool backendRequired = false);

} // namespace vla_backend_selection
