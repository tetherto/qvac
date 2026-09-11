#include "fit/LlamaLoadConfig.hpp"

#include <array>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <common/common.h>

namespace {

using model_fit::BackendDevice;
using model_fit::BackendDeviceType;
using model_fit::LlamaConfigMap;
using model_fit::LlamaLoadKind;
using model_fit::ModelTraits;

int g_failures = 0;

void expect(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    ++g_failures;
  }
}

BackendDevice cpu() {
  return {.name = "CPU", .description = "host", .type = BackendDeviceType::Cpu};
}

BackendDevice metal() {
  return {
      .name = "Metal0",
      .description = "Apple GPU",
      .type = BackendDeviceType::Gpu,
      .handle = reinterpret_cast<ggml_backend_dev_t>(1)};
}

BackendDevice adreno() {
  return {
      .name = "Vulkan0",
      .description = "Adreno 830",
      .type = BackendDeviceType::Gpu,
      .handle = reinterpret_cast<ggml_backend_dev_t>(2)};
}

BackendDevice device(
    const char* name, const char* description, BackendDeviceType type,
    uintptr_t handle, const char* registryName = "") {
  return {
      .name = name,
      .description = description,
      .type = type,
      .handle = reinterpret_cast<ggml_backend_dev_t>(handle),
      .registryName = registryName};
}

// `llama_model_params::devices` is a NULL-terminated list (llama.h:296), so a
// CPU placement is the bare sentinel and a pinned single-GPU placement is the
// handle followed by it. Asserting the terminator is the point: without it
// `llama_prepare_model_devices` walks past the end of the allocation.
bool isCpuPlacement(const common_params& params) {
  return params.devices.size() == 1 && params.devices.front() == nullptr &&
         params.main_gpu == -1;
}

bool isPinnedGpu(const common_params& params, const BackendDevice& expected) {
  return params.devices.size() == 2 &&
         params.devices.front() == expected.handle &&
         params.devices.back() == nullptr && params.main_gpu == 0;
}

// Checks a two-device `tensor-split` positionally. A malformed value never
// arrives as an unsupported result: fabric runs `std::stof` per field, and an
// empty one escapes its handler as `std::invalid_argument` that can terminate
// the process instead of unwinding ("stof: no conversion", observed while
// verifying these cases). That is the whole reason the value has to be
// sanitized before fabric parses it, so these cases assert on a clean parse
// rather than trying to catch a throw.
bool splitsAcross(
    const std::string& tensorSplit, const std::vector<BackendDevice>& devices,
    float first, float second) {
  const auto normalized = model_fit::normalizeLlamaLoadConfig(
      "/model.gguf",
      LlamaConfigMap{
          {"device", "gpu"},
          {"split-mode", "layer"},
          {"tensor-split", tensorSplit}},
      ModelTraits{},
      devices);
  return normalized.supported && normalized.params.tensor_split[0] == first &&
         normalized.params.tensor_split[1] == second;
}

} // namespace

int main() {
  {
    const auto embedding = model_fit::normalizeLlamaLoadConfig(
        LlamaLoadKind::Embedding,
        "/embedding.gguf",
        LlamaConfigMap{{"device", "cpu"}},
        ModelTraits{},
        {cpu()});
    const auto completionWithLegacyEmbedding =
        model_fit::normalizeLlamaLoadConfig(
            LlamaLoadKind::Completion,
            "/completion.gguf",
            LlamaConfigMap{{"device", "cpu"}, {"embedding", ""}},
            ModelTraits{},
            {cpu()});
    expect(
        embedding.params.embedding,
        "load kind must select embedding normalization");
    expect(
        !completionWithLegacyEmbedding.supported,
        "embedding params key must not select embedding normalization");
  }

  {
    const auto normalized = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "cpu"},
            {"ctx-size", "2048"},
            {"batch-size", "256"},
            {"ubatch-size", "128"},
            {"parallel", "2"},
            {"gpu-layers", "8"},
            {"swa-full", ""},
            {"no-mmap", "true"}},
        ModelTraits{},
        {cpu()});

    expect(normalized.supported, "ordinary CPU config must be supported");
    expect(
        normalized.params.split_mode == LLAMA_SPLIT_MODE_NONE,
        "CPU config must use NONE split mode");
    expect(
        isCpuPlacement(normalized.params),
        "CPU config must pass the NULL-terminated zero-device list");
    expect(
        normalized.params.n_gpu_layers == 8,
        "CPU config must leave gpu-layers as the caller wrote it");
    expect(
        normalized.params.n_ctx == 2048,
        "ctx-size must be parsed by qvac-fabric");
    expect(
        normalized.params.n_batch == 256,
        "batch-size must be parsed by qvac-fabric");
    expect(
        normalized.params.n_ubatch == 128,
        "ubatch-size must be parsed by qvac-fabric");
    expect(
        normalized.params.n_parallel == 2,
        "parallel must be parsed by qvac-fabric");
    expect(normalized.params.swa_full, "full SWA must be retained");
    expect(
        normalized.params.load_mode == LLAMA_LOAD_MODE_NONE,
        "no-mmap must disable mmap");

    common_params convertedParams = normalized.params;
    const llama_model_params modelParams =
        common_model_params_to_llama(convertedParams);
    const llama_context_params contextParams =
        common_context_params_to_llama(convertedParams);
    expect(
        modelParams.n_gpu_layers == 8,
        "model conversion must preserve the requested gpu-layers");
    expect(
        contextParams.n_ctx == 2048,
        "context conversion must preserve context size");
    expect(
        contextParams.n_seq_max == 2,
        "context conversion must preserve parallel slots");
    expect(contextParams.swa_full, "context conversion must preserve full SWA");
  }

  {
    const auto normalized = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "cpu"}, {"load-mode", "dio"}},
        ModelTraits{},
        {cpu()});

    expect(normalized.supported, "load-mode config must be supported");
    expect(
        normalized.params.load_mode == LLAMA_LOAD_MODE_DIRECT_IO,
        "load-mode must select direct I/O");
  }

  {
    const auto metalEmbedding = model_fit::normalizeLlamaLoadConfig(
        LlamaLoadKind::Embedding,
        "/embedding.gguf",
        LlamaConfigMap{
            {"device", "gpu"},
            {"batch-size", "256"},
            {"ubatch-size", "64"},
            {"parallel", "1"}},
        ModelTraits{},
        {metal(), cpu()});
    expect(
        metalEmbedding.supported, "Metal embedding config must be supported");
    expect(
        metalEmbedding.params.flash_attn_type == LLAMA_FLASH_ATTN_TYPE_AUTO,
        "embedding must not inherit completion flash default");
    expect(
        metalEmbedding.params.cache_type_k == GGML_TYPE_F16 &&
            metalEmbedding.params.cache_type_v == GGML_TYPE_F16,
        "embedding must not inherit completion q8 KV defaults");
    expect(
        metalEmbedding.params.kv_unified,
        "single-parallel embedding must enable unified KV");
    expect(
        metalEmbedding.params.n_ubatch == metalEmbedding.params.n_batch &&
            metalEmbedding.params.n_batch == 256,
        "embedding ubatch must equal batch");

    const auto openClEmbedding = model_fit::normalizeLlamaLoadConfig(
        LlamaLoadKind::Embedding,
        "/embedding.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {device("OpenCL0", "Adreno 830", BackendDeviceType::Gpu, 1, "OpenCL"),
         cpu()});
    expect(
        openClEmbedding.params.flash_attn_type ==
            LLAMA_FLASH_ATTN_TYPE_DISABLED,
        "OpenCL embedding must default flash attention off");
    expect(
        openClEmbedding.params.cache_type_k == GGML_TYPE_F16 &&
            openClEmbedding.params.cache_type_v == GGML_TYPE_F16,
        "OpenCL embedding must retain unquantized KV defaults");

    const auto parallelEmbedding = model_fit::normalizeLlamaLoadConfig(
        LlamaLoadKind::Embedding,
        "/embedding.gguf",
        LlamaConfigMap{
            {"device", "cpu"},
            {"batch-size", "128"},
            {"ubatch-size", "32"},
            {"parallel", "2"}},
        ModelTraits{},
        {cpu()});
    expect(
        !parallelEmbedding.params.kv_unified,
        "multi-parallel embedding must not force unified KV");
    expect(
        parallelEmbedding.params.n_ubatch == parallelEmbedding.params.n_batch &&
            parallelEmbedding.params.n_batch == 128,
        "multi-parallel embedding ubatch must equal batch");

    for (const char* description : {"Adreno 740", "Adreno 830"}) {
      const BackendDevice openCl =
          device("OpenCL0", description, BackendDeviceType::Gpu, 7, "OpenCL");
      const auto bitnetEmbedding = model_fit::normalizeLlamaLoadConfig(
          LlamaLoadKind::Embedding,
          "/embedding-bitnet.gguf",
          LlamaConfigMap{{"device", "gpu"}},
          ModelTraits{.architecture = "bitnet", .hasOneBitQuantization = true},
          {openCl, cpu()});
      expect(
          isPinnedGpu(bitnetEmbedding.params, openCl),
          "BitNet embedding must select eligible Adreno OpenCL");
    }
  }

  {
    // Two eligible GPUs, because a two-share `tensor-split` is only a
    // well-formed value for a two-device split: one share per device in the
    // final list is what fabric applies positionally, and any other count is
    // rejected rather than zero-padded or truncated.
    const BackendDevice metal1 =
        device("Metal1", "Apple GPU 1", BackendDeviceType::Gpu, 3, "Metal");
    const auto normalized = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"},
            {"ctx_size", "4096"},
            {"split-mode", "layer"},
            {"tensor-split", "0.25,0.75"}},
        ModelTraits{},
        {metal(), metal1, cpu()});

    expect(normalized.supported, "ordinary GPU config must be supported");
    expect(
        normalized.params.split_mode == LLAMA_SPLIT_MODE_LAYER,
        "layer split must be kept as written");
    expect(
        normalized.params.flash_attn_type == LLAMA_FLASH_ATTN_TYPE_ENABLED,
        "ordinary GPU config must default flash attention on");
    expect(
        normalized.params.cache_type_k == GGML_TYPE_Q8_0 &&
            normalized.params.cache_type_v == GGML_TYPE_Q8_0,
        "ordinary Metal/Vulkan GPU config must default K/V cache to q8_0");
    expect(
        normalized.params.n_ctx == 4096,
        "underscore aliases must be normalized");
    expect(
        normalized.params.tensor_split[0] == 0.25F &&
            normalized.params.tensor_split[1] == 0.75F,
        "tensor split must be parsed by qvac-fabric");
  }

  {
    const auto normalized = model_fit::normalizeLlamaLoadConfig(
        "/bitnet.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"ubatch-size", "512"}},
        ModelTraits{.architecture = "bitnet", .hasOneBitQuantization = true},
        {adreno(), cpu()});

    expect(normalized.supported, "BitNet GPU config must be supported");
    expect(
        normalized.params.flash_attn_type == LLAMA_FLASH_ATTN_TYPE_DISABLED,
        "BitNet must default flash attention off");
    expect(
        normalized.params.n_ubatch == 128,
        "BitNet on Adreno 800+ must cap ubatch at 128");

    const auto explicitFlash = model_fit::normalizeLlamaLoadConfig(
        "/bitnet.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"flash-attn", "on"}},
        ModelTraits{.architecture = "bitnet", .hasOneBitQuantization = true},
        {metal(), cpu()});
    expect(
        explicitFlash.params.cache_type_k == GGML_TYPE_Q8_0 &&
            explicitFlash.params.cache_type_v == GGML_TYPE_Q8_0,
        "explicit BitNet flash attention must use the ordinary GPU KV default");
  }

  {
    constexpr std::array<const char*, 10> quantizedKvTypes = {
        "q4_0",
        "q4_1",
        "q5_0",
        "q5_1",
        "q8_0",
        "iq4_nl",
        "tbq3_0",
        "tbq4_0",
        "pq3_0",
        "pq4_0"};
    constexpr std::array<const char*, 3> openClSafeKvTypes = {
        "f32", "f16", "bf16"};
    constexpr std::array<const char*, 4> turboPolarKvTypes = {
        "tbq3_0", "tbq4_0", "pq3_0", "pq4_0"};

    const auto openClAuto = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {device("OpenCL0", "Adreno 830", BackendDeviceType::Gpu, 1), cpu()});
    expect(
        openClAuto.supported,
        "ordinary Adreno OpenCL config must be supported");
    expect(
        openClAuto.params.cache_type_k == GGML_TYPE_F16 &&
            openClAuto.params.cache_type_v == GGML_TYPE_F16,
        "Adreno OpenCL must not auto-default quantized KV");

    for (const char* type : openClSafeKvTypes) {
      const auto safe = model_fit::normalizeLlamaLoadConfig(
          "/model.gguf",
          LlamaConfigMap{
              {"device", "gpu"},
              {"cache-type-k", type},
              {"cache-type-v", type}},
          ModelTraits{},
          {device("OpenCL0", "Adreno 830", BackendDeviceType::Gpu, 1), cpu()});
      expect(safe.supported, "f32/f16/bf16 KV must be supported on OpenCL");
    }
    for (const char* type : quantizedKvTypes) {
      const auto rejected = model_fit::normalizeLlamaLoadConfig(
          "/model.gguf",
          LlamaConfigMap{
              {"device", "gpu"}, {"cache-type-k", type}, {"flash-attn", "off"}},
          ModelTraits{},
          {device("OpenCL0", "Adreno 830", BackendDeviceType::Gpu, 1), cpu()});
      expect(
          !rejected.supported,
          "every quantized KV type must be unsupported on Adreno OpenCL");
    }

    const auto vulkanAuto = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {device("Vulkan0", "Adreno 830", BackendDeviceType::Gpu, 1), cpu()});
    expect(
        vulkanAuto.supported,
        "ordinary Adreno Vulkan config must be supported");
    expect(
        vulkanAuto.params.cache_type_k == GGML_TYPE_F16 &&
            vulkanAuto.params.cache_type_v == GGML_TYPE_F16,
        "Adreno 800+ Vulkan must not auto-default quantized KV");

    for (const char* type : quantizedKvTypes) {
      const auto rejected = model_fit::normalizeLlamaLoadConfig(
          "/model.gguf",
          LlamaConfigMap{
              {"device", "gpu"}, {"cache-type-v", type}, {"flash-attn", "on"}},
          ModelTraits{},
          {device("Vulkan0", "Adreno 830", BackendDeviceType::Gpu, 1), cpu()});
      expect(
          !rejected.supported,
          "every quantized KV type with flash attention must be unsupported on "
          "Adreno 800+ Vulkan");
    }

    const auto metalStandard = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"cache-type-k", "q4_0"}},
        ModelTraits{},
        {device("Metal0", "Apple GPU", BackendDeviceType::Gpu, 1), cpu()});
    expect(
        metalStandard.supported,
        "standard quantized KV must remain supported on Metal");
    for (const char* type : turboPolarKvTypes) {
      const auto rejected = model_fit::normalizeLlamaLoadConfig(
          "/model.gguf",
          LlamaConfigMap{{"device", "gpu"}, {"cache-type-v", type}},
          ModelTraits{},
          {device("Metal0", "Apple GPU", BackendDeviceType::Gpu, 1), cpu()});
      expect(
          !rejected.supported,
          "TurboQuant and PolarQuant KV must be unsupported on Metal");
    }
  }

  {
    const auto booleans = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "cpu"},
            {"no-kv-offload", "true"},
            {"no-op-offload", "false"},
            {"no-host", "true"}},
        ModelTraits{},
        {cpu()});
    expect(booleans.supported, "memory-bearing negated booleans must parse");
    expect(
        booleans.params.no_kv_offload,
        "no-kv-offload=true must disable KV offload");
    expect(
        !booleans.params.no_op_offload,
        "no-op-offload=false must keep op offload");
    expect(booleans.params.no_host, "no-host=true must disable host buffers");

    const auto positiveAliases = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "cpu"}, {"kv_offload", "false"}, {"op-offload", "true"}},
        ModelTraits{},
        {cpu()});
    expect(positiveAliases.supported, "positive boolean aliases must parse");
    expect(
        positiveAliases.params.no_kv_offload,
        "kv-offload=false must disable KV offload");
    expect(
        !positiveAliases.params.no_op_offload,
        "op-offload=true must keep op offload");

    // `--no-host` is a valueless flag upstream (handler_void, no negative
    // form): the token is never consulted, so the real load sets `no_host`
    // whichever value the caller wrote. A `false` therefore describes a
    // placement the flag cannot express and must not project the opposite one.
    const auto falseVoidFlag = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "cpu"}, {"no_host", "false"}},
        ModelTraits{},
        {cpu()});
    expect(
        !falseVoidFlag.supported && falseVoidFlag.unsupportedDetail.find(
                                        "no-host") != std::string::npos,
        "no-host=false must be unsupported rather than keep host buffers");

    // qvac-fabric registers no `--no-extra-bufts` / `--extra-bufts` for
    // LLAMA_EXAMPLE_COMMON, so neither this package nor the addons can express
    // it and it must not be silently accepted.
    for (const char* key : {"no-extra-bufts", "extra-bufts", "host"}) {
      const auto absentFlag = model_fit::normalizeLlamaLoadConfig(
          "/model.gguf",
          LlamaConfigMap{{"device", "cpu"}, {key, "true"}},
          ModelTraits{},
          {cpu()});
      expect(
          !absentFlag.supported,
          "settings qvac-fabric does not register must be unsupported");
    }
  }

  {
    // Two allowlisted keys for one field would otherwise be applied in
    // unordered_map order, making the verdict depend on hash buckets.
    const std::array<std::pair<const char*, const char*>, 4> conflicts = {
        {{"gpu-layers", "n-gpu-layers"},
         {"kv-offload", "no-kv-offload"},
         {"op-offload", "no-op-offload"},
         {"load-mode", "no-mmap"}}};
    for (const auto& [first, second] : conflicts) {
      bool rejected = false;
      try {
        static_cast<void>(model_fit::normalizeLlamaLoadConfig(
            "/model.gguf",
            LlamaConfigMap{{"device", "gpu"}, {first, "10"}, {second, "40"}},
            ModelTraits{},
            {metal(), cpu()}));
      } catch (const std::invalid_argument& error) {
        rejected = std::string(error.what()).find("use only one of") !=
                   std::string::npos;
      }
      expect(rejected, "conflicting key aliases must be rejected loudly");
    }
  }

  {
    // The q8_0 KV auto-default must fire on exactly the spelling
    // `llm-llamacpp` recognizes, or the projection halves the KV footprint the
    // load will actually use.
    const auto flashOn = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"flash-attn", "on"}},
        ModelTraits{},
        {metal(), cpu()});
    expect(
        flashOn.params.cache_type_k == GGML_TYPE_Q8_0 &&
            flashOn.params.cache_type_v == GGML_TYPE_Q8_0,
        "flash-attn=on must apply the quantized KV auto-default");

    const auto flashTruthy = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"flash_attn", "true"}},
        ModelTraits{},
        {metal(), cpu()});
    expect(
        flashTruthy.params.cache_type_k == GGML_TYPE_F16 &&
            flashTruthy.params.cache_type_v == GGML_TYPE_F16,
        "flash-attn=true must keep f16 KV, matching llm-llamacpp");
  }

  {
    // `common/fit.h`: the fitter rewrites the context size "if and only if
    // equal to 0", so an unset embedding context has to be pinned or the fit
    // reports a reduced nCtx for a load that runs at the trained context.
    common_params unset;
    unset.n_ctx = 0;
    model_fit::applyEmbeddingContextPolicy(unset, 2048);
    expect(unset.n_ctx == 2048, "unset embedding context must pin to trained");

    common_params oversized;
    oversized.n_ctx = 8192;
    model_fit::applyEmbeddingContextPolicy(oversized, 2048);
    expect(
        oversized.n_ctx == 2048,
        "oversized embedding context must cap, matching embed-llamacpp");

    common_params within;
    within.n_ctx = 1024;
    model_fit::applyEmbeddingContextPolicy(within, 2048);
    expect(within.n_ctx == 1024, "in-range embedding context must be kept");

    common_params unknownTrained;
    unknownTrained.n_ctx = 0;
    model_fit::applyEmbeddingContextPolicy(unknownTrained, 0);
    expect(
        unknownTrained.n_ctx == 0,
        "unreadable trained context must leave the request alone");
  }

  {
    const BackendDevice gpuOne =
        device("Vulkan0", "GPU one", BackendDeviceType::Gpu, 11);
    const BackendDevice gpuTwo =
        device("Vulkan1", "GPU two", BackendDeviceType::Gpu, 22);
    const auto selected = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"}, {"split-mode", "none"}, {"main-gpu", "2"}},
        ModelTraits{},
        {cpu(), gpuOne, gpuTwo});
    expect(selected.supported, "valid global main-gpu index must be supported");
    expect(
        isPinnedGpu(selected.params, gpuTwo),
        "main-gpu must select the requested global device and terminate the "
        "list");

    const auto fallback = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"}, {"split-mode", "none"}, {"main-gpu", "99"}},
        ModelTraits{},
        {cpu(), gpuOne, gpuTwo});
    expect(fallback.supported, "invalid main-gpu index must fall back");
    expect(
        isPinnedGpu(fallback.params, gpuOne),
        "invalid main-gpu must fall back to ordinary GPU selection");

    const auto cpuFirst = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"}, {"split-mode", "none"}, {"main-gpu", "0"}},
        ModelTraits{},
        {cpu(), gpuOne});
    expect(cpuFirst.supported, "raw CPU main-gpu must fall back to CPU");
    expect(
        isCpuPlacement(cpuFirst.params),
        "main-gpu zero must preserve the raw CPU registry identity");

    const BackendDevice accelerator =
        device("ANE0", "accelerator", BackendDeviceType::Accelerator, 33);
    const auto acceleratorFirst = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"}, {"split-mode", "none"}, {"main-gpu", "0"}},
        ModelTraits{},
        {accelerator, gpuOne});
    expect(
        acceleratorFirst.supported, "raw accelerator main-gpu must be handled");
    expect(
        isCpuPlacement(acceleratorFirst.params),
        "main-gpu zero must preserve the raw accelerator registry identity");
  }

  {
    const BackendDevice vulkan =
        device("Vulkan0", "local GPU", BackendDeviceType::Gpu, 34, "Vulkan");
    const auto row = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"split-mode", "row"}},
        ModelTraits{},
        {vulkan, cpu()});
    expect(
        !row.supported &&
            row.unsupportedDetail ==
                "split-mode row is not accepted: no supported backend "
                "provides split buffers; use layer",
        "split-mode row must be rejected and redirected to layer");
    expect(
        model_fit::preBackendUnsupportedLlamaLoad(
            LlamaConfigMap{{"device", "gpu"}, {"split-mode", "row"}},
            model_fit::LlamaFitPlatform::Desktop) == row.unsupportedDetail,
        "split-mode row must be rejected before backend discovery");
  }

  {
    const BackendDevice rpc =
        device("VulkanRPC", "remote GPU", BackendDeviceType::Gpu, 41, "RPC");
    const BackendDevice vulkan =
        device("Vulkan0", "local GPU", BackendDeviceType::Gpu, 42, "Vulkan");
    const auto rpcOnly = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {rpc, cpu()});
    expect(
        isPinnedGpu(rpcOnly.params, rpc), "RPC-only inventory must select RPC");

    const BackendDevice cudaOnlyDevice =
        device("CUDA0", "NVIDIA GPU", BackendDeviceType::Gpu, 42, "CUDA");
    const auto cudaOnly = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {cudaOnlyDevice, cpu()});
    expect(
        isPinnedGpu(cudaOnly.params, cudaOnlyDevice),
        "CUDA-only inventory must select CUDA");

    const auto mixed = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"split-mode", "none"}},
        ModelTraits{},
        {rpc, vulkan, cpu()});
    expect(
        isPinnedGpu(mixed.params, rpc),
        "mixed inventory must preserve eligible registry order");

    const BackendDevice rocm =
        device("ROCm0", "AMD Radeon", BackendDeviceType::Gpu, 45, "HIP");
    const auto rocmOnly = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {rocm, cpu()});
    expect(
        isCpuPlacement(rocmOnly.params),
        "ROCm-only inventory must fall back to CPU");

    const auto splitMixed = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"split-mode", "layer"}},
        ModelTraits{},
        {rocm, vulkan, cpu()});
    expect(
        splitMixed.params.devices.size() == 2 &&
            splitMixed.params.devices.front() == vulkan.handle &&
            splitMixed.params.devices.back() == nullptr,
        "split-mode device list must exclude ROCm and remain terminated");

    const BackendDevice vulkan1 =
        device("Vulkan1", "NVIDIA GPU 1", BackendDeviceType::Gpu, 46, "Vulkan");

    const auto remappedTensorSplit = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"},
            {"split-mode", "layer"},
            {"tensor-split", "1,2,3"}},
        ModelTraits{},
        {rocm, vulkan, vulkan1, cpu()});
    expect(
        remappedTensorSplit.supported &&
            remappedTensorSplit.params.tensor_split[0] == 2.0F &&
            remappedTensorSplit.params.tensor_split[1] == 3.0F,
        "tensor shares must follow surviving source GPU positions");

    const auto ambiguousTensorSplit = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"},
            {"split-mode", "layer"},
            {"tensor-split", "2,3"}},
        ModelTraits{},
        {rocm, vulkan, vulkan1, cpu()});
    expect(
        ambiguousTensorSplit.supported &&
            ambiguousTensorSplit.params.tensor_split[0] == 2.0F &&
            ambiguousTensorSplit.params.tensor_split[1] == 3.0F,
        "final-list tensor shares must remain positional after filtering");

    // Fabric tokenizes `--tensor-split` on the regex [,/]+, so a run of
    // delimiters collapses and "1,,2" is two shares, not three. The old
    // getline split kept the empty field, read three shares, took the
    // one-share-per-registered-GPU branch and so shifted every share one
    // device right — emitting ",2", whose empty leading field fabric's
    // std::stof then threw on. The llm and embed addons accept this value.
    expect(
        splitsAcross("1,,2", {rocm, vulkan, vulkan1, cpu()}, 1.0F, 2.0F),
        "collapsed tensor-split delimiters must yield one share per surviving "
        "device");
    expect(
        splitsAcross("1, 2", {rocm, vulkan, vulkan1, cpu()}, 1.0F, 2.0F),
        "tensor shares must be trimmed before reaching qvac-fabric");
    expect(
        splitsAcross(",1,2", {vulkan, vulkan1, cpu()}, 1.0F, 2.0F),
        "a leading tensor-split delimiter must not survive into the emitted "
        "value, which fabric's std::stof would throw on");

    const auto shortTensorSplit = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"}, {"split-mode", "layer"}, {"tensor-split", "1"}},
        ModelTraits{},
        {vulkan, vulkan1, cpu()});
    expect(
        !shortTensorSplit.supported &&
            shortTensorSplit.unsupportedDetail ==
                "tensor-split cardinality does not match the registered GPU "
                "device list after filtering",
        "a short tensor-split list must be rejected even when the device "
        "mapping did not move: fabric zero-pads it and leaves the second GPU "
        "with no layers");

    const auto longTensorSplit = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"},
            {"split-mode", "layer"},
            {"tensor-split", "1,2,3"}},
        ModelTraits{},
        {vulkan, vulkan1, cpu()});
    expect(
        !longTensorSplit.supported &&
            longTensorSplit.unsupportedDetail ==
                "tensor-split cardinality does not match the registered GPU "
                "device list after filtering",
        "a long tensor-split list must be rejected even when the device "
        "mapping did not move: fabric silently drops the tail");

    // One share per eligible device is read as the final order whether or not
    // that order is stable. Here ROCm filters out and the RPC device is
    // hoisted ahead of the local GPU, so the surviving source indices run
    // {2, 1}; the retired order-stability gate rejected this outright.
    expect(
        splitsAcross("1,2", {rocm, vulkan, rpc, cpu()}, 1.0F, 2.0F),
        "final-list tensor shares must be accepted across a reordered device "
        "list");

    const auto unrelatedTensorSplit = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"},
            {"split-mode", "layer"},
            {"tensor-split", "1,2,3,4"}},
        ModelTraits{},
        {rocm, vulkan, vulkan1, cpu()});
    expect(
        !unrelatedTensorSplit.supported &&
            unrelatedTensorSplit.unsupportedDetail ==
                "tensor-split cardinality does not match the registered GPU "
                "device list after filtering",
        "a tensor-split list matching neither the eligible nor the registered "
        "GPU count must be rejected");

    const auto layerMainGpu = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"}, {"split-mode", "layer"}, {"main-gpu", "0"}},
        ModelTraits{},
        {rocm, vulkan, vulkan1, cpu()});
    expect(
        layerMainGpu.params.main_gpu == 0 &&
            layerMainGpu.params.devices.front() == vulkan.handle,
        "layer split must keep its inert main-gpu and eligible devices");

    const auto mappedMainGpu = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"}, {"split-mode", "none"}, {"main-gpu", "1"}},
        ModelTraits{},
        {rocm, vulkan, vulkan1, cpu()});
    expect(
        mappedMainGpu.params.main_gpu == 0 &&
            mappedMainGpu.params.devices.front() == vulkan.handle,
        "main-gpu must index the raw registry before allowlist validation");

    const auto cpuFirstMainGpu = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"}, {"split-mode", "none"}, {"main-gpu", "0"}},
        ModelTraits{},
        {cpu(), vulkan, vulkan1});
    expect(
        isCpuPlacement(cpuFirstMainGpu.params),
        "main-gpu targeting a raw CPU registry entry must fall back to CPU");

    const auto handles = model_fit::eligibleBackendDeviceHandles(
        {rocm, vulkan, cpu()}, model_fit::LlamaLoadKind::Completion);
    expect(
        handles.size() == 2 && handles.front() == vulkan.handle &&
            handles.back() == nullptr,
        "generic fit device seam must exclude ROCm");
    expect(
        model_fit::isSupportedGpuOrdinal(
            {rocm, vulkan, vulkan1, cpu()},
            model_fit::LlamaLoadKind::Completion,
            1),
        "a supported raw target must map to the one-device fit list");
    expect(
        !model_fit::isSupportedGpuOrdinal(
            {cpu(), vulkan, vulkan1}, model_fit::LlamaLoadKind::Completion, 0),
        "main-gpu targeting a raw CPU entry must be rejected");
    expect(
        !model_fit::isSupportedGpuOrdinal(
            {rocm, vulkan, vulkan1, cpu()},
            model_fit::LlamaLoadKind::Completion,
            0),
        "main-gpu targeting a raw ROCm entry must be rejected");
    expect(
        !model_fit::isSupportedGpuOrdinal(
            {rocm, vulkan, vulkan1, cpu()},
            model_fit::LlamaLoadKind::Completion,
            4),
        "main-gpu past the registry must be rejected");
    llama_model_params fitParams = llama_model_default_params();
    std::vector<ggml_backend_dev_t> fitDeviceStorage;
    const bool applied = model_fit::applyBackendDeviceAllowlist(
        fitParams,
        fitDeviceStorage,
        {rocm, vulkan, vulkan1, cpu()},
        model_fit::LlamaLoadKind::Completion,
        1);
    expect(
        applied && fitParams.devices == fitDeviceStorage.data() &&
            fitParams.devices[0] == vulkan.handle &&
            fitParams.devices[1] == nullptr && fitParams.main_gpu == 0,
        "generic common_fit_params seam must isolate the supported raw "
        "main-gpu target");
    llama_model_params excludedFitParams = llama_model_default_params();
    std::vector<ggml_backend_dev_t> excludedFitStorage;
    expect(
        !model_fit::applyBackendDeviceAllowlist(
            excludedFitParams,
            excludedFitStorage,
            {rocm, vulkan, vulkan1, cpu()},
            model_fit::LlamaLoadKind::Completion,
            0),
        "generic common_fit_params seam must reject an unsupported raw "
        "main-gpu target");

    const BackendDevice mtlRegistry = device(
        "Apple GPU", "Apple M3", BackendDeviceType::IntegratedGpu, 48, "MTL");
    const auto mtlConfig = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {mtlRegistry, cpu()});
    expect(
        isPinnedGpu(mtlConfig.params, mtlRegistry),
        "MTL registry identity must be eligible without a Metal device name");

    const BackendDevice falseVulkan = device(
        "Future0", "Future GPU", BackendDeviceType::Gpu, 49, "NotVulkan");
    const auto falseVulkanConfig = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {falseVulkan, cpu()});
    expect(
        isCpuPlacement(falseVulkanConfig.params),
        "registry family matching must use exact identities");

    const BackendDevice falseVulkanName = device(
        "NotVulkan0", "Future GPU", BackendDeviceType::Gpu, 51, "Future");
    const auto falseVulkanNameConfig = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {falseVulkanName, cpu()});
    expect(
        isCpuPlacement(falseVulkanNameConfig.params),
        "device family matching must use known prefixes");

    // Dedup is on the raw `device_id`, as fabric compares it: one card seen
    // through CUDA and Vulkan collapses, virtual MPS/MIG devices stay distinct.
    BackendDevice cuda =
        device("CUDA0", "NVIDIA GPU", BackendDeviceType::Gpu, 52, "CUDA");
    BackendDevice sameGpuVulkan =
        device("Vulkan0", "NVIDIA GPU", BackendDeviceType::Gpu, 53, "Vulkan");
    cuda.deviceId = "0000:01:00.0";
    sameGpuVulkan.deviceId = "0000:01:00.0";
    const auto sameCard = model_fit::eligibleBackendDeviceHandles(
        {cuda, sameGpuVulkan, cpu()}, model_fit::LlamaLoadKind::Completion);
    expect(
        sameCard.size() == 2 && sameCard.front() == cuda.handle,
        "one card seen through CUDA and Vulkan must be kept once");

    BackendDevice virtualZero =
        device("CUDA0", "NVIDIA GPU", BackendDeviceType::Gpu, 58, "CUDA");
    BackendDevice virtualOne =
        device("CUDA1", "NVIDIA GPU", BackendDeviceType::Gpu, 59, "CUDA");
    virtualZero.deviceId = "0000:01:00.0-v0";
    virtualOne.deviceId = "0000:01:00.0-v1";
    const auto virtualDevices = model_fit::eligibleBackendDeviceHandles(
        {virtualZero, virtualOne, cpu()}, model_fit::LlamaLoadKind::Completion);
    expect(
        virtualDevices.size() == 3 && virtualDevices[0] == virtualZero.handle &&
            virtualDevices[1] == virtualOne.handle,
        "virtual CUDA devices with distinct ids must both be kept");

    BackendDevice rpcFirst = rpc;
    const BackendDevice localIntegrated = device(
        "MTL0", "Apple GPU", BackendDeviceType::IntegratedGpu, 55, "MTL");
    const auto rpcAndIntegrated = model_fit::eligibleBackendDeviceHandles(
        {localIntegrated, rpcFirst, cpu()},
        model_fit::LlamaLoadKind::Completion);
    expect(
        rpcAndIntegrated.size() == 3 &&
            rpcAndIntegrated[0] == rpcFirst.handle &&
            rpcAndIntegrated[1] == localIntegrated.handle,
        "RPC must be prepended without suppressing the local iGPU");

    BackendDevice adrenoIntegrated = device(
        "OpenCL0",
        "Adreno 830",
        BackendDeviceType::IntegratedGpu,
        56,
        "OpenCL");
    const auto finalSplitTraits = model_fit::normalizeLlamaLoadConfig(
        model_fit::LlamaLoadKind::Embedding,
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"split-mode", "layer"}},
        ModelTraits{},
        {adrenoIntegrated, vulkan, cpu()});
    expect(
        finalSplitTraits.params.devices.front() == vulkan.handle &&
            finalSplitTraits.params.flash_attn_type !=
                LLAMA_FLASH_ATTN_TYPE_DISABLED,
        "split-mode traits must come from the final discrete device set");

    BackendDevice rocmDiscrete = rocm;
    rocmDiscrete.deviceId = "pci-amd";
    adrenoIntegrated.handle = reinterpret_cast<ggml_backend_dev_t>(54);
    expect(
        model_fit::eligibleBackendDeviceHandles(
            {rocmDiscrete, adrenoIntegrated, cpu()},
            model_fit::LlamaLoadKind::Completion)
                .front() == adrenoIntegrated.handle,
        "unsupported discrete GPUs must not hide an eligible integrated GPU");

    // Pins the pre-10549 first-iGPU rule that llm, embed and model-fit all
    // share. Fabric 10549 keeps the first iGPU plus every later one from the
    // same backend registry; two distinct iGPUs under one registry with no
    // eligible discrete GPU is the only shape the rules disagree on, and no
    // shipped backend configuration reaches it. Changing this assertion means
    // overriding a recorded decision, not fixing a bug: the reasoning is at
    // the retention site in LlamaLoadConfig.cpp.
    BackendDevice firstIntegrated = device(
        "Vulkan0",
        "Integrated GPU 0",
        BackendDeviceType::IntegratedGpu,
        60,
        "Vulkan");
    BackendDevice secondIntegrated = device(
        "Vulkan1",
        "Integrated GPU 1",
        BackendDeviceType::IntegratedGpu,
        61,
        "Vulkan");
    firstIntegrated.deviceId = "igpu-0";
    secondIntegrated.deviceId = "igpu-1";
    const auto twoIntegrated = model_fit::eligibleBackendDeviceHandles(
        {firstIntegrated, secondIntegrated, cpu()},
        model_fit::LlamaLoadKind::Completion);
    expect(
        twoIntegrated.size() == 2 &&
            twoIntegrated.front() == firstIntegrated.handle,
        "only the first integrated GPU must survive, even for distinct iGPUs "
        "sharing one registry that fabric 10549 would both keep");

    const BackendDevice legacyDreno = device(
        "OpenCL0",
        "Qualcomm dreno-compatible",
        BackendDeviceType::Gpu,
        50,
        "OpenCL");
    const auto completionDreno = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {legacyDreno, cpu()});
    const auto embeddingDreno = model_fit::normalizeLlamaLoadConfig(
        model_fit::LlamaLoadKind::Embedding,
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {legacyDreno, cpu()});
    expect(
        isPinnedGpu(completionDreno.params, legacyDreno) &&
            isCpuPlacement(embeddingDreno.params),
        "completion dreno and embedding adreno policies must remain distinct");

    const auto nonAdrenoOpenCl = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {device("OpenCL0", "Mali GPU", BackendDeviceType::Gpu, 43, "OpenCL"),
         cpu()});
    expect(
        isCpuPlacement(nonAdrenoOpenCl.params),
        "non-Adreno OpenCL inventory must fall back to CPU");

    const BackendDevice adrenoOpenCl =
        device("OpenCL0", "Adreno 830", BackendDeviceType::Gpu, 44, "OpenCL");
    const auto eligibleAdrenoOpenCl = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"split-mode", "none"}},
        ModelTraits{},
        {adrenoOpenCl, cpu()});
    expect(
        isPinnedGpu(eligibleAdrenoOpenCl.params, adrenoOpenCl),
        "Adreno OpenCL inventory must remain eligible");

    // Eligibility and traits share one family predicate, so a registry-only
    // OpenCL identity is both selected and treated as OpenCL.
    const BackendDevice registryOpenCl =
        device("GPU0", "Adreno 830", BackendDeviceType::Gpu, 57, "OpenCL");
    const auto registryOpenClEmbedding = model_fit::normalizeLlamaLoadConfig(
        model_fit::LlamaLoadKind::Embedding,
        "/embedding.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{},
        {registryOpenCl, cpu()});
    expect(
        isPinnedGpu(registryOpenClEmbedding.params, registryOpenCl) &&
            registryOpenClEmbedding.params.flash_attn_type ==
                LLAMA_FLASH_ATTN_TYPE_DISABLED,
        "registry-only OpenCL identity must drive eligibility and traits "
        "alike");
  }

  {
    // Split-mode traits are properties of the final device set, not of the
    // device that happens to be listed first.
    const BackendDevice rpcRemote =
        device("RPC0", "remote GPU", BackendDeviceType::Gpu, 61, "RPC");
    const BackendDevice adrenoVulkan =
        device("Vulkan0", "Adreno 830", BackendDeviceType::Gpu, 62, "Vulkan");
    const auto rpcThenAdreno = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"split-mode", "layer"}},
        ModelTraits{},
        {rpcRemote, adrenoVulkan, cpu()});
    expect(
        rpcThenAdreno.supported && rpcThenAdreno.params.devices.size() == 3 &&
            rpcThenAdreno.params.devices.front() == rpcRemote.handle &&
            rpcThenAdreno.params.devices[1] == adrenoVulkan.handle,
        "RPC must stay first in the split list");
    expect(
        rpcThenAdreno.params.cache_type_k == GGML_TYPE_F16 &&
            rpcThenAdreno.params.cache_type_v == GGML_TYPE_F16,
        "Adreno 800+ Vulkan traits must come from the local device behind RPC");

    const BackendDevice discreteVulkan =
        device("Vulkan0", "NVIDIA GPU", BackendDeviceType::Gpu, 63, "Vulkan");
    const BackendDevice adrenoOpenClDiscrete =
        device("GPUOpenCL", "Adreno 830", BackendDeviceType::Gpu, 64, "OpenCL");
    const auto vulkanThenOpenCl = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"split-mode", "layer"}},
        ModelTraits{},
        {discreteVulkan, adrenoOpenClDiscrete, cpu()});
    expect(
        vulkanThenOpenCl.supported &&
            vulkanThenOpenCl.params.devices.size() == 3 &&
            vulkanThenOpenCl.params.devices.front() == discreteVulkan.handle,
        "Vulkan must stay first in the split list");
    expect(
        vulkanThenOpenCl.params.cache_type_k == GGML_TYPE_F16 &&
            vulkanThenOpenCl.params.cache_type_v == GGML_TYPE_F16,
        "an OpenCL participant must suppress the q8_0 KV auto-default");
    const auto quantizedOnOpenClSet = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"},
            {"split-mode", "layer"},
            {"cache-type-k", "q8_0"}},
        ModelTraits{},
        {discreteVulkan, adrenoOpenClDiscrete, cpu()});
    expect(
        !quantizedOnOpenClSet.supported,
        "an OpenCL participant must reject quantized KV for the whole set");
  }

  {
    const auto bitnetAdrenoBelow800 = model_fit::normalizeLlamaLoadConfig(
        "/bitnet.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{.architecture = "bitnet", .hasOneBitQuantization = true},
        {device("Vulkan0", "Adreno 740", BackendDeviceType::Gpu, 1), cpu()});
    expect(
        bitnetAdrenoBelow800.supported,
        "Vulkan-only Adreno BitNet fallback must remain representable");
    expect(
        isCpuPlacement(bitnetAdrenoBelow800.params),
        "one-bit BitNet on Adreno <800 must fall back to CPU");

    const auto bitnetLike = model_fit::normalizeLlamaLoadConfig(
        "/bitnet-like.gguf",
        LlamaConfigMap{{"device", "gpu"}},
        ModelTraits{.architecture = "bitnet", .hasOneBitQuantization = false},
        {device("Vulkan0", "Adreno 740", BackendDeviceType::Gpu, 1), cpu()});
    expect(
        bitnetLike.supported,
        "non-one-bit bitnet-like metadata must be supported");
    expect(
        !bitnetLike.params.devices.empty() &&
            bitnetLike.params.devices.front() != nullptr &&
            bitnetLike.params.flash_attn_type == LLAMA_FLASH_ATTN_TYPE_ENABLED,
        "non-one-bit bitnet-like metadata must use ordinary GPU defaults");

    for (const char* description : {"Adreno 740", "Adreno 830"}) {
      const auto completion = model_fit::normalizeLlamaLoadConfig(
          "/bitnet.gguf",
          LlamaConfigMap{{"device", "gpu"}},
          ModelTraits{.architecture = "bitnet", .hasOneBitQuantization = true},
          {device("OpenCL0", description, BackendDeviceType::Gpu, 8, "OpenCL"),
           cpu()});
      expect(
          isCpuPlacement(completion.params),
          "BitNet completion Adreno policy must remain CPU fallback");
    }
  }

  {
    int completionFitCalls = 0;
    auto completion = model_fit::normalizeLlamaLoadConfig(
        "/completion.gguf",
        LlamaConfigMap{
            {"device", "cpu"},
            {"ctx-size", "512"},
            {"batch-size", "128"},
            {"ubatch-size", "64"}},
        ModelTraits{},
        {cpu()});
    expect(
        completion.supported, "completion config must normalize as supported");
    common_params_fit_status completionStatus = COMMON_PARAMS_FIT_STATUS_ERROR;
    const bool completionAccepted = model_fit::withSupportedLlamaLoad(
        completion, [&](common_params& params) {
          completionStatus = model_fit::invokeLlamaFit(
                                 "/completion.gguf",
                                 params,
                                 1024,
                                 512,
                                 [&](const char*,
                                     llama_model_params*,
                                     llama_context_params*,
                                     float*,
                                     llama_model_tensor_buft_override*,
                                     size_t*,
                                     uint32_t,
                                     ggml_log_level) {
                                   ++completionFitCalls;
                                   return COMMON_PARAMS_FIT_STATUS_SUCCESS;
                                 })
                                 .status;
        });
    expect(
        completionAccepted &&
            completionStatus == COMMON_PARAMS_FIT_STATUS_SUCCESS &&
            completionFitCalls == 1,
        "completion config must invoke the fitter exactly once");

    int embeddingFitCalls = 0;
    auto embedding = model_fit::normalizeLlamaLoadConfig(
        LlamaLoadKind::Embedding,
        "/embedding.gguf",
        LlamaConfigMap{
            {"device", "cpu"},
            {"ctx-size", "512"},
            {"batch-size", "128"},
            {"ubatch-size", "64"}},
        ModelTraits{},
        {cpu()});
    expect(embedding.supported, "embedding config must normalize as supported");
    common_params_fit_status embeddingStatus = COMMON_PARAMS_FIT_STATUS_ERROR;
    const bool embeddingAccepted = model_fit::withSupportedLlamaLoad(
        embedding, [&](common_params& params) {
          embeddingStatus = model_fit::invokeLlamaFit(
                                "/embedding.gguf",
                                params,
                                1024,
                                512,
                                [&](const char*,
                                    llama_model_params*,
                                    llama_context_params*,
                                    float*,
                                    llama_model_tensor_buft_override*,
                                    size_t*,
                                    uint32_t,
                                    ggml_log_level) {
                                  ++embeddingFitCalls;
                                  return COMMON_PARAMS_FIT_STATUS_SUCCESS;
                                })
                                .status;
        });
    expect(
        embeddingAccepted &&
            embeddingStatus == COMMON_PARAMS_FIT_STATUS_SUCCESS &&
            embeddingFitCalls == 1,
        "embedding config must invoke the fitter exactly once");

    int unsupportedFitCalls = 0;
    auto unsupported = model_fit::normalizeLlamaLoadConfig(
        "/unsupported.gguf",
        LlamaConfigMap{{"device", "cpu"}, {"unknown-setting", "1"}},
        ModelTraits{},
        {cpu()});
    const bool unsupportedAccepted = model_fit::withSupportedLlamaLoad(
        unsupported, [&](common_params& params) {
          model_fit::invokeLlamaFit(
              "/unsupported.gguf",
              params,
              1024,
              512,
              [&](const char*,
                  llama_model_params*,
                  llama_context_params*,
                  float*,
                  llama_model_tensor_buft_override*,
                  size_t*,
                  uint32_t,
                  ggml_log_level) {
                ++unsupportedFitCalls;
                return COMMON_PARAMS_FIT_STATUS_SUCCESS;
              });
        });
    expect(
        !unsupportedAccepted && unsupportedFitCalls == 0,
        "unsupported config must not invoke the fitter");
  }

  {
    bool tensorSplitAccepted = true;
    bool deviceAccepted = true;
    bool unknownAccepted = true;
    try {
      model_fit::validateLlamaLoadFitCriticalIntegers(
          LlamaConfigMap{{"tensor-split", "2147483648"}});
    } catch (const std::invalid_argument&) {
      tensorSplitAccepted = false;
    }
    try {
      model_fit::validateLlamaLoadFitCriticalIntegers(
          LlamaConfigMap{{"device", "2147483648"}});
    } catch (const std::invalid_argument&) {
      deviceAccepted = false;
    }
    try {
      model_fit::validateLlamaLoadFitCriticalIntegers(
          LlamaConfigMap{{"unknown-setting", "2147483648"}});
    } catch (const std::invalid_argument&) {
      unknownAccepted = false;
    }
    expect(
        tensorSplitAccepted,
        "numeric-looking string handlers must not be narrowed as integers");
    expect(
        deviceAccepted, "custom device values must be deferred to load policy");
    expect(
        unknownAccepted,
        "unknown numeric-looking values must be deferred to load policy");

    const auto numericDevice = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "2147483648"}},
        ModelTraits{},
        {cpu()});
    expect(
        !numericDevice.supported,
        "numeric-looking custom device values must remain unsupported config");

    const auto numericUnknown = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "cpu"}, {"unknown-setting", "2147483648"}},
        ModelTraits{},
        {cpu()});
    expect(
        !numericUnknown.supported,
        "numeric-looking unknown values must remain unsupported config");
  }

  {
    const std::array<std::pair<const char*, const char*>, 8> unsupportedCases =
        {std::pair{"lora", "/adapter.gguf"},
         std::pair{"shards", "2"},
         std::pair{"stream", "true"},
         std::pair{"mmproj", "/projector.gguf"},
         std::pair{"finetune", "true"},
         std::pair{"rope-scale", "2"},
         std::pair{"yarn-orig-ctx", "4096"},
         std::pair{"unknown-setting", "1"}};
    for (const auto& [key, value] : unsupportedCases) {
      const LlamaConfigMap config = {{"device", "cpu"}, {key, value}};
      expect(
          model_fit::preBackendUnsupportedLlamaLoad(config).has_value(),
          "known unsupported config must classify before environment checks");
      const auto normalized = model_fit::normalizeLlamaLoadConfig(
          "/missing-model.gguf", config, ModelTraits{}, {});
      expect(
          !normalized.supported,
          "unsupported config must win with no backend devices");
    }
    expect(
        !model_fit::preBackendUnsupportedLlamaLoad(
             LlamaConfigMap{{"device", "cpu"}})
             .has_value(),
        "supported config must continue to environment checks");
    expect(
        model_fit::preBackendUnsupportedLlamaLoad(
            LlamaConfigMap{{"device", "cpu"}},
            model_fit::LlamaFitPlatform::Mobile)
            .has_value(),
        "mobile platform must classify unsupported before backend discovery");

    const auto mobile = model_fit::normalizeLlamaLoadConfig(
        "/missing-model.gguf",
        LlamaConfigMap{{"device", "cpu"}},
        ModelTraits{},
        {},
        model_fit::LlamaFitPlatform::Mobile);
    expect(
        !mobile.supported &&
            mobile.unsupportedDetail.find("mobile") != std::string::npos,
        "mobile unsupported must win with no backend and missing model");
    const auto desktop = model_fit::normalizeLlamaLoadConfig(
        "/missing-model.gguf",
        LlamaConfigMap{{"device", "cpu"}},
        ModelTraits{},
        {},
        model_fit::LlamaFitPlatform::Desktop);
    expect(
        desktop.supported,
        "supported desktop config must continue to environment checks");
  }

  {
    constexpr std::array<std::pair<const char*, const char*>, 4> symbolicCases =
        {std::pair{"main-gpu", "integrated"},
         std::pair{"main_gpu", "integrated"},
         std::pair{"main-gpu", "dedicated"},
         std::pair{"main_gpu", "dedicated"}};
    for (const auto& [key, value] : symbolicCases) {
      const auto symbolic = model_fit::normalizeLlamaLoadConfig(
          "/model.gguf",
          LlamaConfigMap{{"device", "gpu"}, {key, value}},
          ModelTraits{},
          {metal(), cpu()});
      expect(!symbolic.supported, "symbolic main-gpu must be unsupported");
    }

    const auto lora = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"lora", "/adapter.gguf"}},
        ModelTraits{},
        {metal(), cpu()});
    expect(!lora.supported, "LoRA must be unsupported");

    const auto unknown = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "cpu"}, {"unknown-setting", "1"}},
        ModelTraits{},
        {cpu()});
    expect(!unknown.supported, "unknown settings must not be discarded");

    const auto streaming = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "cpu"}, {"stream", "true"}},
        ModelTraits{},
        {cpu()});
    expect(!streaming.supported, "streaming loads must be unsupported");
  }

  return g_failures == 0 ? 0 : 1;
}
