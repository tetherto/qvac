#include "ggml.h"
#include "ggml-backend.h"
#include "ggml-alloc.h"
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <vector>

static void require(bool ok, const char* message) {
    if (!ok) { std::fprintf(stderr, "%s\n", message); std::exit(2); }
}

static float random_value(uint32_t& state) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (static_cast<int>(state & 65535) - 32768) / 32768.0f;
}

int main(int argc, char** argv) {
    require(argc == 5, "Usage: mmq-isolate CUDA_MODULE OUTPUT N SEED");
    const int64_t k = 14336, m = 3072;
    const int64_t n = std::strtol(argv[3], nullptr, 10);
    uint32_t state = static_cast<uint32_t>(std::strtoul(argv[4], nullptr, 10));
    require((n == 1600 || n == 1616 || n == 1664) && state, "Unsupported shape/seed");
    require(ggml_backend_load(argv[1]) != nullptr, "Cannot load CUDA module");
    auto backend = ggml_backend_init_by_name("CUDA0", nullptr);
    require(backend != nullptr, "CUDA0 unavailable");
    const ggml_init_params params = {16 * 1024 * 1024, nullptr, true};
    auto weights_ctx = ggml_init(params);
    auto graph_ctx = ggml_init(params);
    require(weights_ctx && graph_ctx, "Cannot allocate tensor contexts");
    auto weights = ggml_new_tensor_2d(weights_ctx, GGML_TYPE_Q8_0, k, m);
    ggml_set_name(weights, "synthetic.blocks.0.ffn.2.weight");
    auto activation = ggml_new_tensor_2d(graph_ctx, GGML_TYPE_F32, k, n);
    ggml_set_name(activation, "synthetic.activation");
    auto output = ggml_mul_mat(graph_ctx, weights, activation);
    ggml_set_name(output, "synthetic.down_projection");
    ggml_set_input(activation);
    ggml_set_output(output);
    auto graph = ggml_new_graph_custom(graph_ctx, 32, false);
    ggml_build_forward_expand(graph, output);
    require(ggml_backend_supports_op(backend, output), "CUDA does not support Q8_0 MUL_MAT");
    auto weights_buffer = ggml_backend_alloc_ctx_tensors(weights_ctx, backend);
    auto compute_buffer = ggml_backend_alloc_ctx_tensors(graph_ctx, backend);
    require(weights_buffer && compute_buffer, "Cannot allocate GPU tensors");
    ggml_backend_buffer_set_usage(weights_buffer, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
    ggml_backend_buffer_clear(weights_buffer, 0);
    std::vector<float> row(k);
    std::vector<unsigned char> quantized(ggml_nbytes(weights));
    const size_t row_bytes = ggml_row_size(GGML_TYPE_Q8_0, k);
    for (int64_t i = 0; i < m; ++i) {
        for (float& value : row) value = random_value(state);
        require(ggml_quantize_chunk(GGML_TYPE_Q8_0, row.data(), quantized.data() + i * row_bytes,
                                   0, 1, k, nullptr) == row_bytes, "Quantization size mismatch");
    }
    ggml_backend_tensor_set(weights, quantized.data(), 0, quantized.size());
    std::vector<float> input(k * n);
    for (float& value : input) value = random_value(state);
    ggml_backend_tensor_set(activation, input.data(), 0, input.size() * sizeof(float));
    std::fprintf(stderr, "ISOLATED_MMQ k=%lld m=%lld n=%lld backend=%s\n",
                 static_cast<long long>(k), static_cast<long long>(m), static_cast<long long>(n), ggml_backend_name(backend));
    std::fflush(stderr);
    require(ggml_backend_graph_compute(backend, graph) == GGML_STATUS_SUCCESS, "Matrix multiplication failed");
    ggml_backend_synchronize(backend);
    std::vector<float> values(m * n);
    ggml_backend_tensor_get(output, values.data(), 0, values.size() * sizeof(float));
    size_t nonfinite = 0;
    for (float value : values) nonfinite += !std::isfinite(value);
    std::ofstream file(argv[2], std::ios::binary);
    file.write(reinterpret_cast<const char*>(values.data()), values.size() * sizeof(float));
    file.close();
    require(bool(file), "Cannot save output");
    std::printf("{\"elements\":%zu,\"nonfinite\":%zu}\n", values.size(), nonfinite);
    ggml_backend_buffer_free(compute_buffer);
    ggml_backend_buffer_free(weights_buffer);
    ggml_free(graph_ctx);
    ggml_free(weights_ctx);
    ggml_backend_free(backend);
    return nonfinite ? 3 : 0;
}
