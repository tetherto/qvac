#include <ggml.h>
#include <ggml-backend.h>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <utility>
#include <vector>

static void require(bool ok, const char * message) {
    if (!ok) throw std::runtime_error(message);
}
struct Storage {
    ggml_context * ctx = ggml_init({8 * 1024 * 1024, nullptr, true});
    ggml_backend_buffer_t buffer = nullptr;
    ~Storage() {
        if (buffer) ggml_backend_buffer_free(buffer);
        ggml_free(ctx);
    }
};
static void run(ggml_backend_t backend, int width, int heads, int tokens, int batch) {
    Storage storage;
    auto * ctx = storage.ctx;
    auto * projected = ggml_new_tensor_3d(ctx, GGML_TYPE_F32, 2 * width, tokens, batch);
    auto * left = ggml_cont(ctx, ggml_view_4d(ctx, projected, width, tokens, batch, 1,
        projected->nb[1], projected->nb[2], projected->nb[3], 0));
    auto * right = ggml_cont(ctx, ggml_view_4d(ctx, projected, width, tokens, batch, 1,
        projected->nb[1], projected->nb[2], projected->nb[3], width * sizeof(float)));
    auto * reference = ggml_mul(ctx, ggml_silu(ctx, left), right);
    auto * fused = ggml_swiglu(ctx, projected);
    auto * qkv = ggml_new_tensor_3d(ctx, GGML_TYPE_F32, 3 * 128 * heads, tokens, batch);
    std::vector<std::pair<ggml_tensor *, ggml_tensor *>> pairs{{reference, fused}};
    for (int index = 0; index < 3; ++index) {
        auto * old_slice = ggml_cont(ctx, ggml_view_4d(ctx, qkv, 128 * heads, tokens, batch, 1,
            qkv->nb[1], qkv->nb[2], qkv->nb[3], index * 128 * heads * sizeof(float)));
        auto * old_layout = ggml_reshape_4d(ctx, old_slice, 128, heads, tokens, batch);
        auto * view = ggml_view_4d(ctx, qkv, 128, heads, tokens, batch,
            128 * qkv->nb[0], qkv->nb[1], qkv->nb[2], index * 128 * heads * sizeof(float));
        pairs.emplace_back(old_layout, ggml_cont(ctx, view));
        pairs.emplace_back(ggml_rms_norm(ctx, old_layout, 1e-6f), ggml_rms_norm(ctx, view, 1e-6f));
    }
    auto * graph = ggml_new_graph_custom(ctx, 128, false);
    for (const auto & pair : pairs) {
        ggml_build_forward_expand(graph, pair.first);
        ggml_build_forward_expand(graph, pair.second);
    }
    for (int index = 0; index < ggml_graph_n_nodes(graph); ++index)
        require(ggml_backend_supports_op(backend, ggml_graph_node(graph, index)), "GPU operation unsupported");
    storage.buffer = ggml_backend_alloc_ctx_tensors(ctx, backend);
    require(storage.buffer, "GPU allocation failed");
    for (int pattern = 0; pattern < 3; ++pattern) {
        for (auto * tensor : {projected, qkv}) {
            std::vector<float> values(ggml_nelements(tensor));
            for (size_t index = 0; index < values.size(); ++index)
                values[index] = float(int((index * 17 + pattern * 11) % 129) - 64) / (pattern ? 7.0f : 3.0f);
            ggml_backend_tensor_set(tensor, values.data(), 0, ggml_nbytes(tensor));
        }
        require(ggml_backend_graph_compute(backend, graph) == GGML_STATUS_SUCCESS, "GPU graph failed");
        for (size_t index = 0; index < pairs.size(); ++index) {
            const auto & pair = pairs[index];
            std::vector<float> a(ggml_nelements(pair.first)), b(a.size());
            ggml_backend_tensor_get(pair.first, a.data(), 0, ggml_nbytes(pair.first));
            ggml_backend_tensor_get(pair.second, b.data(), 0, ggml_nbytes(pair.second));
            if (index % 2 == 1) require(a == b, "QKV view is not exact");
            for (size_t element = 0; element < a.size(); ++element)
                require(std::isfinite(a[element]) && std::isfinite(b[element]) &&
                    std::abs(a[element] - b[element]) <= 2e-5f + 2e-6f * std::abs(a[element]),
                    "SwiGLU or strided normalization differs from reference");
        }
    }
}
int main() {
    auto * backend = ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_GPU, nullptr);
    if (!backend) {
        std::cerr << "Required GPU backend unavailable\n";
        return 1;
    }
    try {
        run(backend, 128, 1, 1, 1);
        run(backend, 14336, 5, 17, 2);
        run(backend, 14336, 48, 127, 1);
        std::cout << "PASS H3 existing-operation equivalence: fused SwiGLU, exact QKV views, strided normalization, changing inputs, batches\n";
        ggml_backend_free(backend);
        return 0;
    } catch (const std::exception & error) {
        std::cerr << error.what() << '\n';
        ggml_backend_free(backend);
        return 1;
    }
}
