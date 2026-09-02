#include "fit/LlamaLoadConfig.hpp"

#include <array>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>

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
  return {
      .name = "CPU",
      .description = "host",
      .type = BackendDeviceType::Cpu,
      .supportsSplitBuffer = false};
}

BackendDevice metal() {
  return {
      .name = "Metal0",
      .description = "Apple GPU",
      .type = BackendDeviceType::Gpu,
      .supportsSplitBuffer = false};
}

BackendDevice adreno() {
  return {
      .name = "Vulkan0",
      .description = "Adreno 830",
      .type = BackendDeviceType::Gpu,
      .supportsSplitBuffer = false};
}

BackendDevice device(
    const char* name, const char* description, BackendDeviceType type,
    uintptr_t handle, const char* registryName = "") {
  return {
      .name = name,
      .description = description,
      .type = type,
      .supportsSplitBuffer = false,
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
    const auto normalized = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"},
            {"ctx_size", "4096"},
            {"split-mode", "row"},
            {"tensor-split", "0.25,0.75"}},
        ModelTraits{},
        {metal(), cpu()});

    expect(normalized.supported, "ordinary GPU config must be supported");
    expect(
        normalized.params.split_mode == LLAMA_SPLIT_MODE_LAYER,
        "row split must fall back to layer without split buffers");
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
    // The q8_0 KV auto-default must fire on every spelling `llm-llamacpp`
    // recognizes, or the projection doubles or halves the KV footprint the load
    // will actually use. This block is the only place the parity contract with
    // `llm-llamacpp`'s `resolveFlashAttn` is enforced in code.
    for (const char* value : {"on", "enabled", "true", "1"}) {
      const auto truthy = model_fit::normalizeLlamaLoadConfig(
          "/model.gguf",
          LlamaConfigMap{{"device", "gpu"}, {"flash-attn", value}},
          ModelTraits{},
          {metal(), cpu()});
      expect(
          truthy.params.cache_type_k == GGML_TYPE_Q8_0 &&
              truthy.params.cache_type_v == GGML_TYPE_Q8_0,
          "every truthy flash-attn spelling must apply the quantized KV "
          "auto-default");
    }

    // Underscore-side, so `canonicalKey` stays exercised on this path.
    const auto flashTruthy = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"flash_attn", "true"}},
        ModelTraits{},
        {metal(), cpu()});
    expect(
        flashTruthy.params.cache_type_k == GGML_TYPE_Q8_0 &&
            flashTruthy.params.cache_type_v == GGML_TYPE_Q8_0,
        "flash-attn=true must apply q8_0 KV, matching llm-llamacpp");

    // `'auto'` must not: quantizing V is what makes fabric promote AUTO to
    // ENABLED, skipping the capability probe `'auto'` exists to run. The
    // loader withholds the default for the same reason.
    for (const char* value : {"auto", "-1"}) {
      const auto autoy = model_fit::normalizeLlamaLoadConfig(
          "/model.gguf",
          LlamaConfigMap{{"device", "gpu"}, {"flash-attn", value}},
          ModelTraits{},
          {metal(), cpu()});
      expect(
          autoy.params.cache_type_k == GGML_TYPE_F16 &&
              autoy.params.cache_type_v == GGML_TYPE_F16,
          "flash-attn=auto must keep f16 KV, matching llm-llamacpp");
    }
  }

  {
    // The Adreno 800+/Vulkan crash guard asks the wider question: fabric
    // promotes AUTO to ENABLED for a quantized V cache, so `'auto'` reaches the
    // coopmat1 driver bug and the fitter must not report it as supported when
    // the loader rejects it.
    for (const char* value : {"enabled", "true", "1", "auto", "-1"}) {
      const auto rejected = model_fit::normalizeLlamaLoadConfig(
          "/model.gguf",
          LlamaConfigMap{
              {"device", "gpu"},
              {"flash-attn", value},
              {"cache-type-v", "q8_0"}},
          ModelTraits{},
          {adreno(), cpu()});
      expect(
          !rejected.supported,
          "quantized KV must be unsupported on Adreno 800+ Vulkan for every "
          "flash-attn spelling that can end up enabled");
    }

    // Falsey stays supported: nothing promotes DISABLED.
    const auto falsey = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"},
            {"flash-attn", "off"},
            {"cache-type-v", "q8_0"}},
        ModelTraits{},
        {adreno(), cpu()});
    expect(
        falsey.supported,
        "quantized KV without flash attention must stay supported on Adreno "
        "800+ Vulkan");
  }

  {
    // A value fabric rejects must be reported as the flash-attn value it is.
    // Matching is case-sensitive, as `common_arg_utils` is — and the rejection
    // has to precede the Adreno guard, or a mixed-case `On` with quantized KV
    // surfaces a typo as an unsupported-hardware verdict.
    for (const char* value : {"yes", "On", "TRUE", ""}) {
      std::string detail;
      try {
        static_cast<void>(model_fit::normalizeLlamaLoadConfig(
            "/model.gguf",
            LlamaConfigMap{
                {"device", "gpu"},
                {"flash-attn", value},
                {"cache-type-v", "q8_0"}},
            ModelTraits{},
            {adreno(), cpu()}));
      } catch (const std::invalid_argument& error) {
        detail = error.what();
      }
      expect(
          detail.find("config.flash-attn") != std::string::npos &&
              detail.find("Adreno") == std::string::npos,
          "an unrecognized flash-attn value must be rejected as such, not as "
          "unsupported hardware");
    }
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

    const auto selectedCpu = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"}, {"split-mode", "none"}, {"main-gpu", "0"}},
        ModelTraits{},
        {cpu(), gpuOne});
    expect(selectedCpu.supported, "valid CPU main-gpu index must be supported");
    expect(
        isCpuPlacement(selectedCpu.params),
        "valid CPU main-gpu index must examine only CPU and fall back to CPU");

    const BackendDevice accelerator =
        device("ANE0", "accelerator", BackendDeviceType::Accelerator, 33);
    const auto selectedAccelerator = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{
            {"device", "gpu"}, {"split-mode", "none"}, {"main-gpu", "0"}},
        ModelTraits{},
        {accelerator, gpuOne});
    expect(
        selectedAccelerator.supported,
        "valid accelerator main-gpu index must be supported");
    expect(
        isCpuPlacement(selectedAccelerator.params),
        "valid accelerator main-gpu index must examine only it and fall back "
        "to CPU");

    BackendDevice splitCapable =
        device("Vulkan0", "local GPU", BackendDeviceType::Gpu, 34, "Vulkan");
    splitCapable.supportsSplitBuffer = true;
    const BackendDevice rpcWithoutSplit =
        device("RPC0", "remote GPU", BackendDeviceType::Gpu, 35, "RPC");
    const auto rpcRow = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"split-mode", "row"}},
        ModelTraits{},
        {splitCapable, rpcWithoutSplit, cpu()});
    expect(
        rpcRow.params.split_mode == LLAMA_SPLIT_MODE_LAYER,
        "RPC GPU without split buffers must force row fallback");

    const BackendDevice openClWithoutSplit =
        device("OpenCL0", "Mali GPU", BackendDeviceType::Gpu, 36, "OpenCL");
    const auto openClRow = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"split-mode", "row"}},
        ModelTraits{},
        {splitCapable, openClWithoutSplit, cpu()});
    expect(
        openClRow.params.split_mode == LLAMA_SPLIT_MODE_LAYER,
        "non-Adreno OpenCL GPU without split buffers must force row fallback");
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
        isCpuPlacement(rpcOnly.params),
        "RPC-only inventory must fall back to CPU");

    const auto mixed = model_fit::normalizeLlamaLoadConfig(
        "/model.gguf",
        LlamaConfigMap{{"device", "gpu"}, {"split-mode", "none"}},
        ModelTraits{},
        {rpc, vulkan, cpu()});
    expect(
        isPinnedGpu(mixed.params, vulkan),
        "mixed inventory must ignore RPC and select local GPU");

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
