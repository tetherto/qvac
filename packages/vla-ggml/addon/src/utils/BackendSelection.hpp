#pragma once

#include <string>
#include <vector>

#include <ggml-backend.h>

namespace vla_backend_selection {

// Parse the GPU half of the `backend` config value into a lowercased priority
// list, e.g. "CUDA,Vulkan" -> {"cuda", "vulkan"}. QVAC-23763.
//
// NOTE the asymmetry with llm-llamacpp and embed-llamacpp, which reject "cpu"
// here because those addons have a separate `device` key for it. vla has no
// `device` key: `backend: 'cpu'` has always been how a caller forces CPU, and
// the addon layer strips that case before calling this, so "cpu" never reaches
// it and is not a valid family name.
//
// Names are matched against the backend families qvac-fabric can register, not
// against the devices present on this machine: an unknown NAME is a config
// mistake and throws, while a known name with no device attached is legitimate
// (e.g. asking for cuda on a Vulkan-only host) and falls through to the next
// entry, then to the normal preference order.
//
// BEHAVIOUR CHANGE: before QVAC-23763 any value other than "cpu" was silently
// treated as "pick the best device", so a typo went unnoticed. It now throws.
std::vector<std::string> parseBackendOverride(const std::string& backendStr);

// Extract the Adreno model number from a device description string.
// Returns 0 for non-Adreno devices.
//
//   "Adreno (TM) 830" -> 830
//   "Adreno 740"      -> 740
//   "Mali-G715"       -> 0
int parseAdrenoModel(const std::string& description);

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
// Among accepted devices the order is CUDA, then HIP/ROCm, then anything else
// (Vulkan / Metal). QVAC-23763: CUDA is placed ahead of HIP deliberately. The
// HIP preference below assumes a single AMD-GPU target, and its own comment
// flags the mixed-vendor host (discrete NVIDIA + AMD iGPU) as the case where
// it picks the wrong device. A CUDA device only ever appears on a discrete
// NVIDIA GPU, so preferring it resolves exactly that case. AMD-only hosts are
// unaffected: with no CUDA device present, HIP still wins.
//
// `backendOverride`, when non-empty, restricts the choice to those backend
// families in priority order. Entries with no accepted device are skipped; if
// none match, selection falls through to the normal order rather than failing,
// because an absent device is not a config error. The Adreno gate above still
// applies: an override can never resurrect a device the gate rejected.
//
// Returns nullptr if no acceptable GPU exists; the caller should then init
// the CPU backend.
ggml_backend_dev_t
pickBestGpuDevice(const std::vector<std::string>& backendOverride = {});

} // namespace vla_backend_selection
