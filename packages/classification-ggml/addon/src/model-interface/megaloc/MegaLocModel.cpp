#include "MegaLocModel.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
#include <map>
#include <utility>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml.h>
#include <gguf.h>
#include <inference-addon-cpp/Errors.hpp>
#include <qvac-fabric.h>

namespace classification_ggml::megaloc {
namespace {

using Tensor = ggml_tensor;
using qvac_errors::StatusError;
using qvac_errors::general_error::InternalError;
using qvac_errors::general_error::InvalidArgument;

void check(bool condition, const std::string& message) {
  if (!condition)
    throw StatusError(InvalidArgument, "MegaLoc: " + message);
}

using Context = std::unique_ptr<ggml_context, decltype(&ggml_free)>;
using Gguf = std::unique_ptr<gguf_context, decltype(&gguf_free)>;

} // namespace

int backendId(const char* name) {
  const std::string value(name);
  if (value.starts_with("CPU"))
    return 0;
  if (value.starts_with("Metal") || value.starts_with("MTL"))
    return 1;
  if (value.starts_with("CUDA"))
    return 2;
  if (value.starts_with("Vulkan"))
    return 3;
  if (value.starts_with("OpenCL") || value.starts_with("GPUOpenCL"))
    return 4;
  return 99;
}

struct MegaLocModel::Impl {
  ggml_backend_t device = nullptr;
  ggml_backend_t cpu = nullptr;
  ggml_backend_buffer_t weightBuffer = nullptr;
  ggml_backend_sched_t scheduler = nullptr;
  Context weights{nullptr, ggml_free};
  Context context{nullptr, ggml_free};
  std::map<std::string, Tensor*> tensors;
  ggml_cgraph* graph = nullptr;
  Tensor* input = nullptr;
  Tensor* output = nullptr;
  Tensor* logA = nullptr;
  Tensor* logB = nullptr;
  Tensor* zeroV = nullptr;
  Tensor* positions = nullptr;
  std::array<float, 65> a{};
  std::array<float, PATCH_COUNT> b{};
  std::array<float, PATCH_COUNT> zeros{};
  int fallbackNodes = 0;

  ~Impl() {
    if (scheduler)
      ggml_backend_sched_free(scheduler);
    context.reset();
    if (weightBuffer)
      ggml_backend_buffer_free(weightBuffer);
    weights.reset();
    if (cpu && cpu != device)
      ggml_backend_free(cpu);
    if (device)
      ggml_backend_free(device);
  }

  Tensor* weight(const std::string& name) { return tensors.at(name); }
  ggml_context* ctx() { return context.get(); }

  Tensor* linear(Tensor* x, const std::string& name) {
    auto* y = ggml_mul_mat(ctx(), weight(name + ".weight"), x);
    check(
        ggml_prec_set_acc(y, GGML_PREC_F32), "F32 accumulation is unavailable");
    return ggml_add(ctx(), y, weight(name + ".bias"));
  }

  Tensor* norm(Tensor* x, const std::string& name) {
    return ggml_add(
        ctx(),
        ggml_mul(ctx(), ggml_norm(ctx(), x, 1e-6F), weight(name + ".weight")),
        weight(name + ".bias"));
  }

  Tensor* l2(Tensor* x) {
    return ggml_div(
        ctx(),
        x,
        ggml_sqrt(
            ctx(),
            ggml_clamp(
                ctx(),
                ggml_sum_rows(ctx(), ggml_sqr(ctx(), x)),
                1e-24F,
                1e30F)));
  }

  Tensor* transpose(Tensor* x) {
    return ggml_cont(ctx(), ggml_transpose(ctx(), x));
  }

  Tensor* logSumExp(Tensor* x) {
    auto* maximum = ggml_pool_1d(
        ctx(),
        x,
        GGML_OP_POOL_MAX,
        static_cast<int>(x->ne[0]),
        static_cast<int>(x->ne[0]),
        0);
    return ggml_add(
        ctx(),
        maximum,
        ggml_log(
            ctx(),
            ggml_sum_rows(
                ctx(), ggml_exp(ctx(), ggml_sub(ctx(), x, maximum)))));
  }

  Tensor* attention(Tensor* x, const std::string& name) {
    const int64_t n = x->ne[1];
    auto* qkv = linear(x, name + ".qkv");
    auto* q = ggml_cont(ctx(), ggml_view_2d(ctx(), qkv, 768, n, qkv->nb[1], 0));
    auto* k = ggml_cont(
        ctx(),
        ggml_view_2d(ctx(), qkv, 768, n, qkv->nb[1], 768 * sizeof(float)));
    auto* v = ggml_cont(
        ctx(),
        ggml_view_2d(ctx(), qkv, 768, n, qkv->nb[1], 1536 * sizeof(float)));
    q = ggml_cont(
        ctx(),
        ggml_permute(ctx(), ggml_reshape_3d(ctx(), q, 64, 12, n), 0, 2, 1, 3));
    k = ggml_cont(
        ctx(),
        ggml_permute(ctx(), ggml_reshape_3d(ctx(), k, 64, 12, n), 0, 2, 1, 3));
    v = ggml_cont(
        ctx(),
        ggml_permute(ctx(), ggml_reshape_3d(ctx(), v, 64, 12, n), 1, 2, 0, 3));
    auto* scores = ggml_mul_mat(ctx(), k, q);
    check(
        ggml_prec_set_acc(scores, GGML_PREC_F32),
        "F32 accumulation is unavailable");
    auto* probabilities =
        ggml_soft_max(ctx(), ggml_scale(ctx(), scores, 0.125F));
    auto* values = ggml_mul_mat(ctx(), v, probabilities);
    check(
        ggml_prec_set_acc(values, GGML_PREC_F32),
        "F32 accumulation is unavailable");
    values = ggml_cont(ctx(), ggml_permute(ctx(), values, 0, 2, 1, 3));
    return linear(ggml_reshape_2d(ctx(), values, 768, n), name + ".proj");
  }

  void loadWeights(const std::string& path) {
    std::ifstream stream(path, std::ios::binary | std::ios::ate);
    check(stream.good(), "cannot open GGUF weights");
    const auto end = stream.tellg();
    check(end > 0, "empty GGUF file");
    const auto fileSize = static_cast<uint64_t>(end);
    ggml_context* metadataRaw = nullptr;
    Context metadata(nullptr, ggml_free);
    Gguf gguf(
        gguf_init_from_file(path.c_str(), {true, &metadataRaw}), gguf_free);
    metadata.reset(metadataRaw);
    check(gguf && metadata, "invalid GGUF weights");
    const auto architecture = gguf_find_key(gguf.get(), "general.architecture");
    check(
        architecture >= 0 &&
            gguf_get_kv_type(gguf.get(), architecture) == GGUF_TYPE_STRING &&
            std::string(gguf_get_val_str(gguf.get(), architecture)) ==
                "megaloc",
        "expected megaloc architecture");
    for (const auto& [key, expected] :
         std::array<std::pair<const char*, uint32_t>, 2>{
             {{"megaloc.image_size", IMAGE_SIZE},
              {"megaloc.descriptor_length", DESCRIPTOR_LENGTH}}}) {
      const auto index = gguf_find_key(gguf.get(), key);
      check(
          index >= 0 &&
              gguf_get_kv_type(gguf.get(), index) == GGUF_TYPE_UINT32 &&
              gguf_get_val_u32(gguf.get(), index) == expected,
          std::string("unsupported ") + key);
    }
    check(gguf_get_n_tensors(gguf.get()) <= 512, "too many tensors");
    weights.reset(ggml_init({512 * ggml_tensor_overhead(), nullptr, true}));
    if (!weights)
      throw StatusError(
          InternalError, "MegaLoc weight context allocation failed");

    auto expect = [&](const std::string& name,
                      std::initializer_list<int64_t>
                          shape,
                      ggml_type type) {
      auto* source = ggml_get_tensor(metadata.get(), name.c_str());
      check(source != nullptr, "missing tensor " + name);
      check(
          source->type == type,
          "unsupported tensor type for " + name +
              "; use F16 or F16 body + Q6_K projection");
      size_t axis = 0;
      for (const int64_t dimension : shape)
        check(source->ne[axis++] == dimension, "wrong shape for " + name);
      for (; axis < GGML_MAX_DIMS; ++axis)
        check(source->ne[axis] == 1, "wrong rank for " + name);
      auto* destination = ggml_dup_tensor(weights.get(), source);
      ggml_set_name(destination, name.c_str());
      tensors.emplace(name, destination);
    };
    const auto* projection =
        ggml_get_tensor(metadata.get(), "aggregator.linear.weight");
    check(
        projection && (projection->type == GGML_TYPE_F16 ||
                       projection->type == GGML_TYPE_Q6_K),
        "only F16 and F16 body + Q6_K projection weights are supported");
    auto matrix = [&](const std::string& name,
                      int64_t in,
                      int64_t out,
                      ggml_type type = GGML_TYPE_F16) {
      expect(name + ".weight", {in, out}, type);
      expect(name + ".bias", {out}, GGML_TYPE_F32);
    };
    auto normalization = [&](const std::string& name) {
      expect(name + ".weight", {768}, GGML_TYPE_F32);
      expect(name + ".bias", {768}, GGML_TYPE_F32);
    };
    const std::string positionName =
        ggml_get_tensor(metadata.get(), "megaloc.pos_embed")
            ? "megaloc.pos_embed"
            : "evaluation.pos_embed_322";
    expect(positionName, {768, 530}, GGML_TYPE_F32);
    positions = weight(positionName);
    expect("backbone.cls_token", {768}, GGML_TYPE_F32);
    matrix("backbone.patch_embed.proj", PATCH_WIDTH, 768, GGML_TYPE_F32);
    for (int i = 0; i < 12; ++i) {
      const auto block = "backbone.blocks." + std::to_string(i);
      normalization(block + ".norm1");
      normalization(block + ".norm2");
      matrix(block + ".attn.qkv", 768, 2304);
      matrix(block + ".attn.proj", 768, 768);
      matrix(block + ".mlp.fc1", 768, 3072);
      matrix(block + ".mlp.fc2", 3072, 768);
      expect(block + ".ls1.gamma", {768}, GGML_TYPE_F32);
      expect(block + ".ls2.gamma", {768}, GGML_TYPE_F32);
    }
    normalization("backbone.norm");
    for (const auto* branch : {"cluster_features", "score", "token_features"}) {
      const std::string prefix = std::string("aggregator.agg.") + branch;
      matrix(prefix + ".0", 768, 512);
      const bool token = std::string(branch) == "token_features";
      matrix(
          prefix + (token ? ".2" : ".3"),
          512,
          std::string(branch) == "score" ? 64 : 256);
    }
    expect("aggregator.agg.dust_bin", {1}, GGML_TYPE_F32);
    matrix("aggregator.linear", 16640, DESCRIPTOR_LENGTH, projection->type);

    const uint64_t dataStart = gguf_get_data_offset(gguf.get());
    for (const auto& [name, destination] : tensors) {
      const auto index = gguf_find_tensor(gguf.get(), name.c_str());
      const uint64_t offset = gguf_get_tensor_offset(gguf.get(), index);
      check(
          dataStart <= fileSize && offset <= fileSize - dataStart &&
              ggml_nbytes(destination) <= fileSize - dataStart - offset,
          "truncated tensor " + name);
    }
    weightBuffer = ggml_backend_alloc_ctx_tensors(weights.get(), device);
    if (!weightBuffer)
      throw StatusError(
          InternalError, "MegaLoc weight buffer allocation failed");
    ggml_backend_buffer_set_usage(
        weightBuffer, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
    std::vector<char> chunk(8 * 1024 * 1024);
    for (const auto& [name, destination] : tensors) {
      stream.seekg(
          static_cast<std::streamoff>(
              dataStart +
              gguf_get_tensor_offset(
                  gguf.get(), gguf_find_tensor(gguf.get(), name.c_str()))));
      const size_t size = ggml_nbytes(destination);
      for (size_t offset = 0; offset < size;) {
        const size_t count = std::min(chunk.size(), size - offset);
        stream.read(chunk.data(), static_cast<std::streamsize>(count));
        check(stream.good(), "failed reading tensor " + name);
        ggml_backend_tensor_set(destination, chunk.data(), offset, count);
        offset += count;
      }
    }
  }

  void build() {
    context.reset(ggml_init(
        {4096 * ggml_tensor_overhead() +
             ggml_graph_overhead_custom(8192, false),
         nullptr,
         true}));
    if (!context)
      throw StatusError(
          InternalError, "MegaLoc graph context allocation failed");
    input = ggml_new_tensor_2d(ctx(), GGML_TYPE_F32, PATCH_WIDTH, PATCH_COUNT);
    ggml_set_name(input, "image_patches");
    ggml_set_input(input);
    auto* x = linear(input, "backbone.patch_embed.proj");
    auto* cls = ggml_reshape_2d(ctx(), weight("backbone.cls_token"), 768, 1);
    x = ggml_add(ctx(), ggml_concat(ctx(), cls, x, 1), positions);
    for (int i = 0; i < 12; ++i) {
      const auto block = "backbone.blocks." + std::to_string(i);
      auto* attentionOutput =
          attention(norm(x, block + ".norm1"), block + ".attn");
      x = ggml_add(
          ctx(),
          x,
          ggml_mul(ctx(), attentionOutput, weight(block + ".ls1.gamma")));
      auto* mlp = linear(
          ggml_gelu_erf(
              ctx(), linear(norm(x, block + ".norm2"), block + ".mlp.fc1")),
          block + ".mlp.fc2");
      x = ggml_add(
          ctx(), x, ggml_mul(ctx(), mlp, weight(block + ".ls2.gamma")));
    }
    x = norm(x, "backbone.norm");
    auto* token = ggml_cont(ctx(), ggml_view_2d(ctx(), x, 768, 1, x->nb[1], 0));
    auto* features = ggml_cont(
        ctx(),
        ggml_view_2d(
            ctx(), x, 768, PATCH_COUNT, x->nb[1], 768 * sizeof(float)));
    const std::string agg = "aggregator.agg.";
    token = linear(
        ggml_relu(ctx(), linear(token, agg + "token_features.0")),
        agg + "token_features.2");
    auto* local = linear(
        ggml_relu(ctx(), linear(features, agg + "cluster_features.0")),
        agg + "cluster_features.3");
    auto* scores = linear(
        ggml_relu(ctx(), linear(features, agg + "score.0")), agg + "score.3");
    auto* dustbin = ggml_repeat(
        ctx(),
        weight(agg + "dust_bin"),
        ggml_new_tensor_2d(ctx(), GGML_TYPE_F32, 1, PATCH_COUNT));
    auto* z = ggml_concat(ctx(), scores, dustbin, 0);
    logA = ggml_new_tensor_2d(ctx(), GGML_TYPE_F32, 65, 1);
    logB = ggml_new_tensor_2d(ctx(), GGML_TYPE_F32, PATCH_COUNT, 1);
    zeroV = ggml_new_tensor_2d(ctx(), GGML_TYPE_F32, PATCH_COUNT, 1);
    for (auto* tensor : {logA, logB, zeroV})
      ggml_set_input(tensor);
    Tensor* u = nullptr;
    auto* v = zeroV;
    auto* zt = transpose(z);
    for (int i = 0; i < 3; ++i) {
      u = ggml_sub(ctx(), logA, transpose(logSumExp(ggml_add(ctx(), zt, v))));
      v = ggml_sub(ctx(), logB, transpose(logSumExp(ggml_add(ctx(), z, u))));
    }
    auto* assignment = ggml_exp(
        ctx(),
        ggml_scale_bias(
            ctx(),
            ggml_add(ctx(), ggml_add(ctx(), z, u), transpose(v)),
            1.0F,
            std::log(static_cast<float>(PATCH_COUNT + 64))));
    assignment = ggml_cont(
        ctx(),
        ggml_view_2d(ctx(), assignment, 64, PATCH_COUNT, assignment->nb[1], 0));
    auto* aggregated =
        ggml_mul_mat(ctx(), transpose(local), transpose(assignment));
    check(
        ggml_prec_set_acc(aggregated, GGML_PREC_F32),
        "F32 accumulation is unavailable");
    aggregated = ggml_reshape_2d(ctx(), transpose(l2(aggregated)), 16384, 1);
    auto* descriptor = l2(ggml_concat(ctx(), l2(token), aggregated, 0));
    output = l2(linear(descriptor, "aggregator.linear"));
    ggml_set_output(output);
    graph = ggml_new_graph_custom(ctx(), 8192, false);
    ggml_build_forward_expand(graph, output);
    ggml_backend_t backends[] = {device, cpu};
    scheduler = ggml_backend_sched_new(
        backends, nullptr, device == cpu ? 1 : 2, 8192, false, true);
    if (!scheduler || !ggml_backend_sched_alloc_graph(scheduler, graph)) {
      throw StatusError(InternalError, "MegaLoc graph allocation failed");
    }
    const float value = -std::log(static_cast<float>(PATCH_COUNT + 64));
    a.fill(value);
    a.back() += std::log(static_cast<float>(PATCH_COUNT - 64));
    b.fill(value);
    for (int i = 0; i < ggml_graph_n_nodes(graph); ++i) {
      if (device != cpu && ggml_backend_sched_get_tensor_backend(
                               scheduler, ggml_graph_node(graph, i)) == cpu)
        ++fallbackNodes;
    }
  }

  std::vector<float> run(const std::vector<float>& pixels) {
    // The scheduler may reuse input storage after consumption, including
    // constants.
    ggml_backend_tensor_set(logA, a.data(), 0, sizeof(a));
    ggml_backend_tensor_set(logB, b.data(), 0, sizeof(b));
    ggml_backend_tensor_set(zeroV, zeros.data(), 0, sizeof(zeros));
    ggml_backend_tensor_set(
        input, pixels.data(), 0, pixels.size() * sizeof(float));
    if (ggml_backend_sched_graph_compute(scheduler, graph) !=
        GGML_STATUS_SUCCESS) {
      throw StatusError(InternalError, "MegaLoc graph computation failed");
    }
    std::vector<float> result(DESCRIPTOR_LENGTH);
    ggml_backend_tensor_get(
        output, result.data(), 0, result.size() * sizeof(float));
    double normSquared = 0;
    for (const float value : result) {
      if (!std::isfinite(value))
        throw StatusError(
            InternalError, "MegaLoc produced a non-finite descriptor");
      normSquared += static_cast<double>(value) * value;
    }
    if (std::abs(normSquared - 1.0) > 1e-3)
      throw StatusError(
          InternalError, "MegaLoc produced an invalid descriptor norm");
    return result;
  }
};

MegaLocModel::MegaLocModel(Config config) : config_(std::move(config)) {}
MegaLocModel::~MegaLocModel() = default;

void MegaLocModel::load() {
  std::scoped_lock lock(mutex_);
  if (impl_)
    return;
  check(!config_.modelPath.empty(), "modelPath is required");
  check(
      config_.threads > 0 && config_.threads <= 1024,
      "threads must be between 1 and 1024");
#if defined(GGML_BACKEND_DL)
  if (config_.backendsDir.empty())
    qvac_fabric_load_backends();
  else
    ggml_backend_load_all_from_path(config_.backendsDir.c_str());
#endif
  auto state = std::make_unique<Impl>();
  auto* selected = config_.backend.empty()
                       ? ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU)
                       : ggml_backend_dev_by_name(config_.backend.c_str());
  if (!selected && config_.backend.starts_with("Metal")) {
    const auto name = "MTL" + config_.backend.substr(5);
    selected = ggml_backend_dev_by_name(name == "MTL" ? "MTL0" : name.c_str());
  }
  if (!selected && config_.backend.empty())
    selected = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_IGPU);
  if (!selected && config_.backend.empty())
    selected = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  check(
      selected != nullptr,
      "requested backend is unavailable: " + config_.backend);
  state->device = ggml_backend_dev_init(selected, nullptr);
  if (!state->device)
    throw StatusError(InternalError, "MegaLoc backend initialization failed");
  state->cpu =
      ggml_backend_dev_type(selected) == GGML_BACKEND_DEVICE_TYPE_CPU
          ? state->device
          : ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
  if (!state->cpu)
    throw StatusError(
        InternalError, "MegaLoc CPU backend initialization failed");
  auto* registry =
      ggml_backend_dev_backend_reg(ggml_backend_get_device(state->cpu));
  auto setThreads = reinterpret_cast<void (*)(ggml_backend_t, int)>(
      ggml_backend_reg_get_proc_address(
          registry, "ggml_backend_set_n_threads"));
  if (setThreads)
    setThreads(state->cpu, config_.threads);
  state->loadWeights(config_.modelPath);
  state->build();
  impl_ = std::move(state);
}

std::string MegaLocModel::getName() const { return "megaloc-ggml"; }

std::any MegaLocModel::process(const std::any& input) {
  std::scoped_lock lock(mutex_);
  const auto* image = std::any_cast<ImageInput>(&input);
  check(image != nullptr, "invalid embedding input type");
  if (!impl_)
    throw StatusError(InternalError, "MegaLoc is not loaded");
  const auto start = std::chrono::steady_clock::now();
  auto result = impl_->run(preprocess(*image));
  lastInferenceMs_ = std::chrono::duration<double, std::milli>(
                         std::chrono::steady_clock::now() - start)
                         .count();
  return std::any(std::move(result));
}

qvac_lib_inference_addon_cpp::RuntimeStats MegaLocModel::runtimeStats() const {
  std::scoped_lock lock(mutex_);
  qvac_lib_inference_addon_cpp::RuntimeStats result{
      {"total_time_ms", lastInferenceMs_}};
  if (impl_) {
    result.emplace_back(
        "backend_id",
        static_cast<int64_t>(backendId(ggml_backend_name(impl_->device))));
    result.emplace_back(
        "cpu_fallback_nodes", static_cast<int64_t>(impl_->fallbackNodes));
    result.emplace_back(
        "weight_bytes",
        static_cast<int64_t>(
            ggml_backend_buffer_get_size(impl_->weightBuffer)));
  }
  return result;
}

} // namespace classification_ggml::megaloc
