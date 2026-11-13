#include "PerformanceProfiles.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>

#if defined(__APPLE__)
#include <mach/mach.h>
#include <sys/sysctl.h>
#endif

#include <ggml-backend.h>
#include <gguf.h>
#include <picojson/picojson.h>

#include "VideoModelCapabilities.hpp"

namespace qvac_lib_inference_addon_sd {
namespace {
constexpr uint64_t GIB = uint64_t{1} << 30;

std::string lower(std::string value) {
  std::transform(
      value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
      });
  return value;
}

bool hasTensor(const gguf_context* metadata, const char* name, ggml_type type) {
  const auto index = gguf_find_tensor(metadata, name);
  return index >= 0 && gguf_get_tensor_type(metadata, index) == type;
}

bool ggufSizeMatches(
    const gguf_context* metadata, uint64_t bytes, uint64_t expected,
    uint64_t payload, bool allowMetadataOnly) {
  const auto count = gguf_get_n_tensors(metadata);
  if (count == 0)
    return false;
  const uint64_t alignment = gguf_get_alignment(metadata);
  const uint64_t size = gguf_get_tensor_size(metadata, count - 1);
  const uint64_t padding = (alignment - size % alignment) % alignment;
  const uint64_t offset = gguf_get_tensor_offset(metadata, count - 1);
  // Registry descriptions rewrite tokenizer metadata, but preserve tensor data.
  return offset <= payload && size <= payload - offset &&
         padding == payload - offset - size &&
         (bytes == expected ||
          (allowMetadataOnly && bytes == gguf_get_data_offset(metadata)));
}

bool fileSizeMatches(
    const std::string& path, uint64_t expected, bool allowMetadataOnly,
    uint64_t ggufPayload = 0) {
  std::error_code error;
  const auto bytes = std::filesystem::file_size(path, error);
  if (error)
    return false;
  if (bytes == expected)
    return true;
  if (!allowMetadataOnly)
    return false;
  if (ggufPayload != 0) {
    const std::unique_ptr<gguf_context, decltype(&gguf_free)> metadata(
        gguf_init_from_file(path.c_str(), {true, nullptr}), gguf_free);
    return metadata &&
           ggufSizeMatches(metadata.get(), bytes, expected, ggufPayload, true);
  }
  // Safetensors descriptions retain the original length prefix and JSON header.
  std::ifstream input(path, std::ios::binary);
  uint64_t headerBytes = 0;
  if (!input.read(reinterpret_cast<char*>(&headerBytes), sizeof(headerBytes)) ||
      headerBytes == 0 || headerBytes > 16 * 1024 * 1024 ||
      bytes != sizeof(headerBytes) + headerBytes || bytes >= expected)
    return false;
  std::string header(static_cast<size_t>(headerBytes), '\0');
  if (!input.read(header.data(), static_cast<std::streamsize>(header.size())))
    return false;
  picojson::value metadata;
  if (!picojson::parse(metadata, header).empty() ||
      !metadata.is<picojson::object>())
    return false;
  uint64_t end = 0;
  for (const auto& entry : metadata.get<picojson::object>()) {
    if (entry.first == "__metadata__")
      continue;
    if (!entry.second.is<picojson::object>())
      return false;
    const auto& offsets = entry.second.get("data_offsets");
    if (!offsets.is<picojson::array>() ||
        offsets.get<picojson::array>().size() != 2)
      return false;
    const auto& values = offsets.get<picojson::array>();
    if (!values[0].is<double>() || !values[1].is<double>())
      return false;
    const double start = values[0].get<double>();
    const double finish = values[1].get<double>();
    if (!(start >= 0 && finish >= start && finish <= expected - bytes) ||
        std::floor(start) != start || std::floor(finish) != finish)
      return false;
    end = std::max(end, static_cast<uint64_t>(finish));
  }
  return end == expected - bytes;
}

void readHostMemory(ProfileDevice& device) {
#if defined(__APPLE__)
  size_t size = sizeof(device.hostTotalBytes);
  if (sysctlbyname("hw.memsize", &device.hostTotalBytes, &size, nullptr, 0) !=
      0)
    device.hostTotalBytes = 0;
  const auto host = mach_host_self();
  vm_size_t pageSize = 0;
  vm_statistics64_data_t stats{};
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  if (host_page_size(host, &pageSize) == KERN_SUCCESS &&
      host_statistics64(
          host,
          HOST_VM_INFO64,
          reinterpret_cast<host_info64_t>(&stats),
          &count) == KERN_SUCCESS)
    device.hostFreeBytes =
        (uint64_t{stats.free_count} + stats.inactive_count) * pageSize;
  mach_port_deallocate(mach_task_self(), host);
#elif defined(__linux__)
  std::ifstream input("/proc/meminfo");
  std::string line;
  while (std::getline(input, line)) {
    std::istringstream fields(line);
    std::string key;
    uint64_t kib = 0;
    if (fields >> key >> kib) {
      if (key == "MemAvailable:")
        device.hostFreeBytes = kib * 1024;
      if (key == "MemTotal:")
        device.hostTotalBytes = kib * 1024;
    }
  }
#else
  (void)device;
#endif
}
} // namespace

ProfileModel
inspectProfileModel(const SdCtxConfig& config, bool allowMetadataOnly) {
  if (config.performanceProfile == "off" ||
      !config.highNoiseDiffusionModelPath.empty() ||
      !config.uncondDiffusionModelPath.empty() || !config.taesdPath.empty())
    return ProfileModel::Unknown;
  const auto& path = config.diffusionModelPath;
  std::error_code error;
  const auto bytes = std::filesystem::file_size(path, error);
  if (error || (!allowMetadataOnly && bytes != 4300644928ULL &&
                bytes != 11420663904ULL && bytes != 19388448416ULL))
    return ProfileModel::Unknown;
  const gguf_init_params init{true, nullptr};
  const std::unique_ptr<gguf_context, decltype(&gguf_free)> metadata(
      gguf_init_from_file(path.c_str(), init), gguf_free);
  if (!metadata)
    return ProfileModel::Unknown;
  if (gguf_get_n_tensors(metadata.get()) == 149 &&
      hasTensor(
          metadata.get(),
          "double_blocks.0.img_attn.qkv.weight",
          GGML_TYPE_Q8_0) &&
      ggufSizeMatches(
          metadata.get(),
          bytes,
          4300644928ULL,
          4300634112ULL,
          allowMetadataOnly) &&
      fileSizeMatches(
          config.llmPath, 2497281312ULL, allowMetadataOnly, 2491323904ULL) &&
      fileSizeMatches(config.vaePath, 168120878ULL, allowMetadataOnly))
    return ProfileModel::Flux2Klein4BQ8;
  if (gguf_get_n_tensors(metadata.get()) == 532 &&
      inspectVideoModelCapabilities(path).isMiniMaxH3 &&
      ggufSizeMatches(
          metadata.get(),
          bytes,
          11420663904ULL,
          11420630112ULL,
          allowMetadataOnly) &&
      fileSizeMatches(
          config.llmPath, 18218065024ULL, allowMetadataOnly, 18217999840ULL) &&
      fileSizeMatches(config.vaePath, 5207808496ULL, allowMetadataOnly) &&
      fileSizeMatches(config.audioVaePath, 605254808ULL, allowMetadataOnly))
    return ProfileModel::MiniMaxH3FL2VAQ4;
  if (gguf_get_n_tensors(metadata.get()) == 4444 &&
      hasTensor(
          metadata.get(),
          "transformer_blocks.0.attn1.to_gate_logits.weight",
          GGML_TYPE_Q6_K) &&
      ggufSizeMatches(
          metadata.get(),
          bytes,
          19388448416ULL,
          19388047360ULL,
          allowMetadataOnly) &&
      fileSizeMatches(
          config.embeddingsConnectorsPath, 2312144712ULL, allowMetadataOnly) &&
      fileSizeMatches(
          config.llmPath, 7432229216ULL, allowMetadataOnly, 7425677184ULL) &&
      fileSizeMatches(config.vaePath, 1452256522ULL, allowMetadataOnly) &&
      fileSizeMatches(config.audioVaePath, 364853140ULL, allowMetadataOnly))
    return ProfileModel::Ltx23Q5;
  return ProfileModel::Unknown;
}

ProfileDevice classifyProfileDevice(
    const std::string& api, const std::string& gpu, uint64_t freeBytes,
    uint64_t totalBytes) {
  ProfileDevice result;
  const auto name = lower(api);
  if (name == "cuda")
    result.api = ProfileApi::Cuda;
  if (name == "vulkan")
    result.api = ProfileApi::Vulkan;
  if (name == "mtl" || name == "metal")
    result.api = ProfileApi::Metal;
  if (name == "rocm" || name == "hip")
    result.api = ProfileApi::Hip;
  if (gpu == "NVIDIA GeForce RTX 5090")
    result.gpu = ProfileGpu::Rtx5090;
  if (gpu == "NVIDIA GB10")
    result.gpu = ProfileGpu::Gb10;
  if (gpu == "Apple M3 Ultra")
    result.gpu = ProfileGpu::M3Ultra;
  if (gpu == "Radeon 8060S Graphics" || gpu == "AMD Radeon 8060S Graphics")
    result.gpu = ProfileGpu::StrixHalo;
  result.freeBytes = freeBytes;
  result.totalBytes = totalBytes;
  return result;
}

ProfileDevice
profileDevice(const char* backend, sd_backend_preference_t preference) {
  if (std::getenv("SD_CPU_ONLY"))
    return {};
  std::string name = backend == nullptr ? "" : lower(backend);
  if (name.compare(0, 5, "metal") == 0)
    name.replace(0, 5, "mtl");
  // Mixed module/device assignments need their own validation before opting in.
  if (name.find_first_of("=,&") != std::string::npos || name == "cpu")
    return {};
  ggml_backend_dev_t selected = nullptr;
  if (name.empty()) {
    if (preference != SD_BACKEND_PREF_GPU || std::getenv("SD_VK_DEVICE"))
      return {};
    selected = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
    if (!selected)
      selected = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_IGPU);
  } else {
    const auto registryName = name == "metal" ? "mtl" : name;
    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
      const auto device = ggml_backend_dev_get(i);
      const auto registry = ggml_backend_dev_backend_reg(device);
      if (registry && lower(ggml_backend_reg_name(registry)) == registryName) {
        selected = device;
        break;
      }
    }
    if (!selected) {
      for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        const auto device = ggml_backend_dev_get(i);
        if (lower(ggml_backend_dev_name(device)) == name) {
          selected = device;
          break;
        }
      }
    }
  }
  if (!selected)
    return {};
  const auto registry = ggml_backend_dev_backend_reg(selected);
  if (!registry)
    return {};
  size_t freeBytes = 0, totalBytes = 0;
  ggml_backend_dev_memory(selected, &freeBytes, &totalBytes);
  auto result = classifyProfileDevice(
      ggml_backend_reg_name(registry),
      ggml_backend_dev_description(selected),
      freeBytes,
      totalBytes);
  if (result.gpu == ProfileGpu::M3Ultra || result.gpu == ProfileGpu::Gb10 ||
      result.gpu == ProfileGpu::StrixHalo) {
    readHostMemory(result);
    result.freeBytes = std::min(result.freeBytes, result.hostFreeBytes);
  }
  return result;
}

PerformanceProfile selectPerformanceProfile(
    const SdCtxConfig& config, ProfileModel model,
    const ProfileDevice& device) {
  PerformanceProfile result;
  if (config.performanceProfile == "off" || !config.maxVramSpec.empty() ||
      config.streamLayers || config.wtype != SD_TYPE_COUNT ||
      !config.diffusionFlashAttn || config.vaeAutoCpuFallback ||
      !config.tensorTypeRules.empty())
    return result;
  const bool rtx = device.gpu == ProfileGpu::Rtx5090;
  const bool spark = device.gpu == ProfileGpu::Gb10;
  const bool mac = device.gpu == ProfileGpu::M3Ultra;
  const bool strix = device.gpu == ProfileGpu::StrixHalo;
  const bool cuda = device.api == ProfileApi::Cuda;
  const bool vulkan = device.api == ProfileApi::Vulkan;
  const bool metal = device.api == ProfileApi::Metal;
  const bool hip = device.api == ProfileApi::Hip;
  if (model == ProfileModel::MiniMaxH3FL2VAQ4 &&
      ((rtx && (cuda || vulkan)) || (spark && cuda) || (mac && metal) ||
       (strix && hip))) {
    result.flashAttention = !config.explicitFlashAttention;
    result.h3LocalOps = rtx && (cuda || vulkan) && result.flashAttention &&
                        config.diffusionFlashAttn &&
                        device.freeBytes >= 28 * GIB;
  }
  if (model == ProfileModel::Flux2Klein4BQ8 &&
      ((rtx && cuda) || (spark && cuda)) && !config.explicitVaeConvDirect) {
    result.vaeGemm = true;
    result.vaeGemm512 = cuda;
  }
  if (model == ProfileModel::Ltx23Q5) {
    result.ltxF16 =
        mac && metal && !config.explicitTensorTypeRules &&
        config.tensorTypeRules.empty() && !config.offloadToCpu &&
        (config.paramsBackendSpec.empty() ||
         lower(config.paramsBackendSpec) == "mtl0" ||
         lower(config.paramsBackendSpec) == "metal0" ||
         lower(config.paramsBackendSpec) == "metal") &&
        config.performanceMaxWidth > 0 && config.performanceMaxWidth <= 512 &&
        config.performanceMaxHeight > 0 && config.performanceMaxHeight <= 320 &&
        config.performanceMaxFrames > 0 && config.performanceMaxFrames <= 97 &&
        device.hostTotalBytes >= 96 * GIB && device.hostFreeBytes >= 76 * GIB &&
        device.freeBytes >= 64 * GIB;
  }
  return result;
}

bool useH3LocalOps(
    const PerformanceProfile& profile, int width, int height, int frames) {
  return profile.h3LocalOps && width == 960 && height == 544 && frames == 124;
}

bool useVaeGemm(
    const PerformanceProfile& profile, int width, int height, int batch,
    uint64_t freeBytes, bool vaeTiling) {
  return profile.vaeGemm && !vaeTiling && width == height &&
         (width == 1024 || (width == 512 && profile.vaeGemm512)) &&
         batch == 1 && freeBytes >= 16 * GIB;
}

const char* ltxF16TensorRules() {
  return "^model[.]diffusion_model[.]transformer_blocks[.].*"
         "(to_q|to_k|to_v|to_out[.]0|to_gate_logits|net[.]0[.]proj|net[.]2)"
         "[.]weight$=f16";
}

void validatePerformanceWorkload(
    const SdCtxConfig& config, int width, int height, int frames) {
  if (config.performanceMaxWidth > 0 && (width > config.performanceMaxWidth ||
                                         height > config.performanceMaxHeight ||
                                         frames > config.performanceMaxFrames))
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Video dimensions exceed the declared performance_max_* limits");
}
} // namespace qvac_lib_inference_addon_sd
