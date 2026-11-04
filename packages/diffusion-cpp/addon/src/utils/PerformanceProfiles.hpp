#pragma once

#include <cstdint>
#include <string>

#include "handlers/SdCtxHandlers.hpp"

namespace qvac_lib_inference_addon_sd {

enum class ProfileModel { Unknown, Flux2Klein4BQ8, MiniMaxH3FL2VAQ4, Ltx23Q5 };
enum class ProfileApi { Unknown, Cuda, Vulkan, Metal, Hip };
enum class ProfileGpu { Unknown, Rtx5090, Gb10, M3Ultra, StrixHalo };

struct ProfileDevice {
  ProfileApi api = ProfileApi::Unknown;
  ProfileGpu gpu = ProfileGpu::Unknown;
  uint64_t freeBytes = 0;
  uint64_t totalBytes = 0;
  uint64_t hostFreeBytes = 0;
  uint64_t hostTotalBytes = 0;
};

struct PerformanceProfile {
  bool flashAttention = false;
  bool h3LocalOps = false;
  bool vaeGemm = false;
  bool vaeGemm512 = false;
  bool ltxF16 = false;
  bool ltxFullTemporal = false;
};

ProfileModel inspectProfileModel(const SdCtxConfig& config);
ProfileDevice
profileDevice(const char* backend, sd_backend_preference_t preference);
ProfileDevice classifyProfileDevice(
    const std::string& api, const std::string& gpu, uint64_t freeBytes,
    uint64_t totalBytes);
PerformanceProfile selectPerformanceProfile(
    const SdCtxConfig& config, ProfileModel model, const ProfileDevice& device);
bool useFullTemporalDecode(
    const PerformanceProfile& profile, int width, int height, int frames,
    bool spatialTiling, bool explicitTemporalTiling);
bool useVaeGemm(
    const PerformanceProfile& profile, int width, int height, int batch,
    uint64_t freeBytes);
const char* ltxF16TensorRules();
void validatePerformanceWorkload(
    const SdCtxConfig& config, int width, int height, int frames);

} // namespace qvac_lib_inference_addon_sd
