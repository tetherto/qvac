#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml.h>
#include <qvac-fabric.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace {
constexpr float kTolerance = 0.001F;

struct Comparison {
  const char *name;
  bool passed = true;
};

std::vector<float> readTensor(ggml_tensor *tensor) {
  const auto count = static_cast<size_t>(ggml_nelements(tensor));
  std::vector<float> values(count);
  if (tensor->type == GGML_TYPE_F32) {
    ggml_backend_tensor_get(tensor, values.data(), 0, count * sizeof(float));
  } else {
    std::vector<ggml_fp16_t> halves(count);
    ggml_backend_tensor_get(tensor, halves.data(), 0,
                            count * sizeof(ggml_fp16_t));
    ggml_fp16_to_fp32_row(halves.data(), values.data(), count);
  }
  return values;
}

bool compare(int, ggml_tensor *actual, ggml_tensor *expected, void *data) {
  auto &result = *static_cast<Comparison *>(data);
  const auto gpu = readTensor(actual);
  const auto cpu = readTensor(expected);
  float maximum = 0;
  size_t mismatches = 0;
  double squaredError = 0;
  double energy = 0;
  bool finite = true;
  for (size_t i = 0; i < gpu.size(); ++i) {
    const float error = std::abs(gpu[i] - cpu[i]);
    maximum = std::max(maximum, error);
    squaredError += static_cast<double>(error) * error;
    energy += static_cast<double>(cpu[i]) * cpu[i];
    finite = finite && std::isfinite(gpu[i]) && std::isfinite(cpu[i]);
    if (!std::isfinite(gpu[i]) || !std::isfinite(cpu[i]) ||
        error > kTolerance * (1 + std::abs(cpu[i]))) {
      ++mismatches;
    }
  }
  const double nmse = squaredError / std::max(energy, 1e-30);
  const double limit = actual->op == GGML_OP_MUL_MAT ? 5e-4 : 1e-7;
  std::printf("METAL_OPERATOR %s op=%s type=%s count=%zu mismatches=%zu "
              "max_abs=%g nmse=%g limit=%g\n",
              result.name, ggml_op_name(actual->op),
              ggml_type_name(actual->type), gpu.size(), mismatches,
              static_cast<double>(maximum), nmse, limit);
  if (!finite || nmse > limit) {
    for (size_t i = 0; i < std::min<size_t>(8, gpu.size()); ++i) {
      std::printf("  [%zu] Metal=%g CPU=%g\n", i, static_cast<double>(gpu[i]),
                  static_cast<double>(cpu[i]));
    }
    result.passed = false;
  }
  return result.passed;
}

void fillInputs(ggml_context *context) {
  uint32_t state = 17;
  for (auto *tensor = ggml_get_first_tensor(context); tensor != nullptr;
       tensor = ggml_get_next_tensor(context, tensor)) {
    if (tensor->op != GGML_OP_NONE || tensor->view_src != nullptr) {
      continue;
    }
    const auto count = static_cast<size_t>(ggml_nelements(tensor));
    std::vector<float> values(count);
    for (auto &value : values) {
      state = state * 1664525U + 1013904223U;
      value = static_cast<float>((state >> 8) & 65535U) / 65535.0F - 0.5F;
    }
    if (tensor->type == GGML_TYPE_F32) {
      ggml_backend_tensor_set(tensor, values.data(), 0, count * sizeof(float));
    } else {
      std::vector<ggml_fp16_t> halves(count);
      ggml_fp32_to_fp16_row(values.data(), halves.data(), count);
      ggml_backend_tensor_set(tensor, halves.data(), 0,
                              count * sizeof(ggml_fp16_t));
    }
  }
}

using Build = ggml_tensor *(*)(ggml_context *);

bool runCase(const char *name, Build build, ggml_backend_t metal,
             ggml_backend_t cpu) {
  ggml_init_params parameters{16 * 1024 * 1024, nullptr, true};
  auto *context = ggml_init(parameters);
  auto *output = build(context);
  auto *graph = ggml_new_graph(context);
  ggml_build_forward_expand(graph, output);
  auto *buffer = ggml_backend_alloc_ctx_tensors(context, metal);
  if (buffer == nullptr) {
    std::printf("METAL_OPERATOR %s allocation failed\n", name);
    ggml_free(context);
    return false;
  }
  fillInputs(context);
  Comparison comparison{name};
  const ggml_tensor *outputs[] = {output};
  const bool evaluated = ggml_backend_compare_graph_backend(
      metal, cpu, graph, compare, &comparison, outputs, 1);
  ggml_backend_buffer_free(buffer);
  ggml_free(context);
  return evaluated && comparison.passed;
}

ggml_tensor *im2col(ggml_context *context) {
  auto *kernel = ggml_new_tensor_3d(context, GGML_TYPE_F16, 3, 80, 384);
  auto *signal = ggml_new_tensor_2d(context, GGML_TYPE_F32, 3000, 80);
  return ggml_im2col(context, kernel, signal, 1, 1, 1, 0, 1, 1, false,
                     GGML_TYPE_F16);
}

ggml_tensor *convolution(ggml_context *context) {
  auto *columns = im2col(context);
  auto *weights = ggml_new_tensor_2d(context, GGML_TYPE_F16, 240, 384);
  return ggml_mul_mat(context, weights,
                      ggml_reshape_2d(context, columns, 240, 3000));
}

ggml_tensor *encoder(ggml_context *context) {
  auto *weights = ggml_new_tensor_2d(context, GGML_TYPE_F16, 384, 1536);
  auto *input = ggml_new_tensor_2d(context, GGML_TYPE_F32, 384, 17);
  return ggml_mul_mat(context, weights, input);
}

ggml_tensor *attention(ggml_context *context) {
  auto *keys = ggml_new_tensor_3d(context, GGML_TYPE_F16, 64, 6, 1500);
  auto *query = ggml_new_tensor_3d(context, GGML_TYPE_F32, 64, 5, 6);
  return ggml_mul_mat(context, ggml_permute(context, keys, 0, 2, 1, 3), query);
}

ggml_tensor *attentionValues(ggml_context *context) {
  auto *weights = ggml_soft_max(context, attention(context));
  auto *values = ggml_new_tensor_3d(context, GGML_TYPE_F16, 1500, 64, 6);
  return ggml_mul_mat(context, values, weights);
}

ggml_tensor *normalize(ggml_context *context) {
  return ggml_norm(context, ggml_new_tensor_2d(context, GGML_TYPE_F32, 384, 17),
                   1e-5F);
}

ggml_tensor *normalizeAffine(ggml_context *context) {
  auto *scale = ggml_new_tensor_1d(context, GGML_TYPE_F32, 384);
  auto *bias = ggml_new_tensor_1d(context, GGML_TYPE_F32, 384);
  return ggml_add(context, ggml_mul(context, normalize(context), scale), bias);
}

ggml_tensor *softmax(ggml_context *context) {
  return ggml_soft_max(context,
                       ggml_new_tensor_2d(context, GGML_TYPE_F32, 1500, 5));
}

ggml_tensor *gelu(ggml_context *context) {
  return ggml_gelu(context,
                   ggml_new_tensor_2d(context, GGML_TYPE_F32, 384, 17));
}
} // namespace

int main() {
  qvac_fabric_load_backends();
  auto *device = ggml_backend_dev_by_name("MTL0");
  auto *cpuDevice = ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_CPU);
  if (device == nullptr || cpuDevice == nullptr) {
    std::fprintf(stderr, "Metal and CPU devices are required\n");
    return 1;
  }
  auto *metal = ggml_backend_dev_init(device, nullptr);
  auto *cpu = ggml_backend_dev_init(cpuDevice, nullptr);
  if (metal == nullptr || cpu == nullptr) {
    return 1;
  }
  std::printf("METAL_OPERATOR device=%s\n",
              ggml_backend_dev_description(device));
  const struct {
    const char *name;
    Build build;
  } cases[] = {{"im2col-f16", im2col},
               {"convolution-f16", convolution},
               {"encoder-mul-mat", encoder},
               {"attention-strided", attention},
               {"attention-values", attentionValues},
               {"norm", normalize},
               {"norm-mul-add", normalizeAffine},
               {"softmax", softmax},
               {"gelu", gelu}};
  bool passed = true;
  for (const auto &test : cases) {
    passed = runCase(test.name, test.build, metal, cpu) && passed;
  }
  ggml_backend_free(metal);
  ggml_backend_free(cpu);
  return passed ? 0 : 1;
}
