#include "BridgeDepthGraph.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <functional>
#include <map>
#include <stdexcept>
#include <utility>

#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml.h>
#include <gguf.h>

#include "model-interface/GgmlBackend.hpp"

namespace classification_ggml::bridgedepth {

namespace {

constexpr size_t GRAPH_SIZE = 32768;
constexpr size_t POS_CACHE_LIMIT = 8;
// DINOv2 interpolate_offset: the pos-embed resize scale is (n + 0.1) / M.
constexpr double POS_INTERPOLATE_OFFSET = 0.1;
constexpr float MEAN_RGB[3] = {123.675f, 116.28f, 103.53f};
constexpr float STD_RGB[3] = {58.395f, 57.12f, 57.375f};

using T = ggml_tensor;

// ---- small graph helpers, all tensors image-shaped are ggml [W, H, C, N] ----

T* toChannelsFirst(ggml_context* ctx, T* x) { // [W,H,C,N] -> [C,W,H,N]
  return ggml_cont(ctx, ggml_permute(ctx, x, 1, 2, 0, 3));
}

T* toChannelsLast(ggml_context* ctx, T* x) { // [C,W,H,N] -> [W,H,C,N]
  return ggml_cont(ctx, ggml_permute(ctx, x, 2, 0, 1, 3));
}

T* layerNorm(ggml_context* ctx, T* x, T* w, T* b, float eps) {
  x = ggml_norm(ctx, x, eps);
  x = ggml_mul(ctx, x, w);
  return b ? ggml_add(ctx, x, b) : x;
}

T* linear(ggml_context* ctx, T* x, T* w, T* b) {
  // Token tensors are often [C, 1 or 2, W, H]: passed as is, ne11 is tiny and
  // Metal runs one mat-vec per (W, H) slice, about 10x slower than one GEMM.
  if (ggml_is_contiguous(x) && x->ne[1] != ggml_nrows(x)) {
    const int64_t n1 = x->ne[1], n2 = x->ne[2], n3 = x->ne[3];
    x = ggml_mul_mat(ctx, w, ggml_reshape_2d(ctx, x, x->ne[0], ggml_nrows(x)));
    x = ggml_reshape_4d(ctx, x, x->ne[0], n1, n2, n3);
    return b ? ggml_add(ctx, x, b) : x;
  }
  x = ggml_mul_mat(ctx, w, x);
  return b ? ggml_add(ctx, x, b) : x;
}

// Zero padding at the start of dim 0 or 1. Metal's PAD only pads at the end
// (a leading pad falls back to CPU), so pad at the end and roll the zeros
// round.
T* padFront(ggml_context* ctx, T* x, int p0, int p1) {
  x = ggml_pad_ext(ctx, x, 0, p0, 0, p1, 0, 0, 0, 0);
  return ggml_roll(ctx, x, p0, p1, 0, 0);
}

T* addChannelBias(ggml_context* ctx, T* x, T* b) {
  return ggml_add(ctx, x, ggml_reshape_4d(ctx, b, 1, 1, b->ne[0], 1));
}

// ggml_conv_2d im2cols in F16 for any kernel type but BF16, which costs about
// 1e-3 relative error per conv. Same op sequence with an F32 im2col.
T* conv2d(ggml_context* ctx, T* x, T* w, T* b, int stride, int pad) {
  T* col = ggml_im2col(
      ctx, w, x, stride, stride, pad, pad, 1, 1, true, GGML_TYPE_F32);
  T* y = ggml_mul_mat(
      ctx,
      ggml_reshape_2d(
          ctx, col, col->ne[0], col->ne[3] * col->ne[2] * col->ne[1]),
      ggml_reshape_2d(ctx, w, w->ne[0] * w->ne[1] * w->ne[2], w->ne[3]));
  y = ggml_reshape_4d(ctx, y, col->ne[1], col->ne[2], col->ne[3], w->ne[3]);
  y = ggml_cont(ctx, ggml_permute(ctx, y, 0, 1, 3, 2)); // [OW, OH, OC, N]
  return b ? addChannelBias(ctx, y, b) : y;
}

// ggml_conv_2d_dw im2cols in F16 even for F32 kernels; the direct op stays F32.
T* convDepthwise(ggml_context* ctx, T* x, T* w, T* b, int pad) {
  T* y = ggml_conv_2d_dw_direct(ctx, w, x, 1, 1, pad, pad, 1, 1);
  return b ? addChannelBias(ctx, y, b) : y;
}

// ConvTranspose2d with kernel == stride and no padding, as one mul_mat plus a
// depth-to-space permute. Avoids GGML_OP_CONV_TRANSPOSE_2D, which OpenCL lacks.
// w is torch [IC, OC, k, k] = ggml [k, k, OC, IC]; x is [W, H, IC, 1].
T* convTransposeKS(ggml_context* ctx, T* x, T* w, T* b, int k) {
  const int64_t wDim = x->ne[0], hDim = x->ne[1], inCh = x->ne[2],
                outCh = w->ne[2];
  T* xc = ggml_reshape_2d(ctx, toChannelsFirst(ctx, x), inCh, wDim * hDim);
  T* wm = ggml_cont(
      ctx, ggml_transpose(ctx, ggml_reshape_2d(ctx, w, k * k * outCh, inCh)));
  T* r = ggml_mul_mat(ctx, wm, xc); // [kx + k*ky + k*k*oc, x + W*y]
  r = ggml_reshape_4d(ctx, r, k, k * outCh, wDim, hDim);
  r = ggml_cont(ctx, ggml_permute(ctx, r, 0, 2, 1, 3)); // [kx, x, (ky, oc), y]
  r = ggml_reshape_4d(ctx, r, k * wDim, k, outCh, hDim);
  r = ggml_cont(ctx, ggml_permute(ctx, r, 0, 1, 3, 2)); // [X, ky, y, oc]
  r = ggml_reshape_4d(ctx, r, k * wDim, k * hDim, outCh, 1);
  return addChannelBias(ctx, r, b);
}

// Conv1d along ne0 with an F32 im2col. x [L, IC, N], w torch [OC, IC, K] =
// ggml [K, IC, OC], result [OL, OC, N]. Not the ggml_conv_1d op order: that one
// reshapes [N*OL, OC] straight to [OL, OC, N], which only holds for N == 1.
T* conv1d(ggml_context* ctx, T* x, T* w, T* b, int pad) {
  T* col = ggml_im2col(
      ctx, w, x, 1, 0, pad, 0, 1, 0, false, GGML_TYPE_F32); // [IC*K, OL, N]
  T* y = ggml_mul_mat(
      ctx,
      ggml_reshape_2d(ctx, w, w->ne[0] * w->ne[1], w->ne[2]),
      ggml_reshape_2d(
          ctx, col, col->ne[0], col->ne[2] * col->ne[1]));       // [OC, OL*N]
  y = ggml_reshape_3d(ctx, y, w->ne[2], col->ne[1], col->ne[2]); // [OC, OL, N]
  y = ggml_cont(ctx, ggml_permute(ctx, y, 1, 0, 2, 3));          // [OL, OC, N]
  return b ? ggml_add(ctx, y, ggml_reshape_3d(ctx, b, 1, b->ne[0], 1)) : y;
}

// Concatenates many tensors along `dim` as a balanced tree, so the copied
// bytes grow like n log n instead of n^2 for a chain.
T* concatAll(ggml_context* ctx, std::vector<T*> ts, int dim) {
  while (ts.size() > 1) {
    std::vector<T*> next;
    for (size_t i = 0; i + 1 < ts.size(); i += 2) {
      next.push_back(ggml_concat(ctx, ts[i], ts[i + 1], dim));
    }
    if (ts.size() % 2)
      next.push_back(ts.back());
    ts.swap(next);
  }
  return ts[0];
}

// Channel slice [c0, c0 + n) of a tensor whose ne0 is the channel dim.
T* channelSlice(ggml_context* ctx, T* x, int64_t c0, int64_t n) {
  return ggml_cont(
      ctx,
      ggml_view_4d(
          ctx,
          x,
          n,
          x->ne[1],
          x->ne[2],
          x->ne[3],
          x->nb[1],
          x->nb[2],
          x->nb[3],
          c0 * x->nb[0]));
}

T* bilinear(ggml_context* ctx, T* x, int64_t w, int64_t h, bool alignCorners) {
  uint32_t mode = GGML_SCALE_MODE_BILINEAR;
  if (alignCorners) {
    mode |= GGML_SCALE_FLAG_ALIGN_CORNERS;
  }
  return ggml_interpolate(ctx, x, w, h, x->ne[2], x->ne[3], mode);
}

T* batchSlice(ggml_context* ctx, T* x, int i) {
  return ggml_cont(
      ctx,
      ggml_view_4d(
          ctx,
          x,
          x->ne[0],
          x->ne[1],
          x->ne[2],
          1,
          x->nb[1],
          x->nb[2],
          x->nb[3],
          x->nb[3] * i));
}

// PyTorch upsample_bicubic2d, align_corners=False, A=-0.75, scale given
// explicitly. Used for the DINOv2 pos-embed resize, where the scale is
// (n + 0.1) / M rather than n / M, so ggml_interpolate to a size differs.
float cubic1(float x, float a) { return ((a + 2) * x - (a + 3)) * x * x + 1; }
float cubic2(float x, float a) {
  return ((a * x - 5 * a) * x + 8 * a) * x - 4 * a;
}

struct CubicTaps {
  int64_t idx[4];
  float w[4];
};

std::vector<CubicTaps>
cubicTaps(int64_t inSize, int64_t outSize, double scaleFactor) {
  const float a = -0.75f;
  const float scale = static_cast<float>(1.0 / scaleFactor);
  std::vector<CubicTaps> taps(outSize);
  for (int64_t i = 0; i < outSize; ++i) {
    const float src = scale * (static_cast<float>(i) + 0.5f) - 0.5f;
    const int64_t i0 =
        std::min<int64_t>(static_cast<int64_t>(std::floor(src)), inSize - 1);
    const float t =
        std::min(std::max(src - static_cast<float>(i0), 0.0f), 1.0f);
    const float w[4] = {
        cubic2(t + 1.0f, a),
        cubic1(t, a),
        cubic1(1.0f - t, a),
        cubic2(2.0f - t, a)};
    for (int j = 0; j < 4; ++j) {
      taps[i].idx[j] =
          std::min<int64_t>(std::max<int64_t>(i0 - 1 + j, 0), inSize - 1);
      taps[i].w[j] = w[j];
    }
  }
  return taps;
}

} // namespace

Padding computePadding(int h, int w, int divisor) {
  Padding p;
  p.top = (((h / divisor) + 1) * divisor - h) % divisor;
  p.right = (((w / divisor) + 1) * divisor - w) % divisor;
  return p;
}

void padImageInto(const float* chw, int h, int w, Padding pad, float* out) {
  const int hDim = h + pad.top, wDim = w + pad.right;
  for (int c = 0; c < 3; ++c) {
    for (int y = 0; y < hDim; ++y) {
      const int sy = std::max(y - pad.top, 0);
      for (int x = 0; x < wDim; ++x) {
        const int sx = std::min(x, w - 1);
        out[(static_cast<size_t>(c) * hDim + y) * wDim + x] =
            chw[(static_cast<size_t>(c) * h + sy) * w + sx];
      }
    }
  }
}

std::vector<float> padImage(const float* chw, int h, int w, Padding pad) {
  std::vector<float> out(
      static_cast<size_t>(3) * (h + pad.top) * (w + pad.right));
  padImageInto(chw, h, w, pad, out.data());
  return out;
}

namespace {
// Host tensor in torch layout: `shape` is the torch shape, `data` row-major.
struct HostTensor {
  std::vector<int64_t> shape;
  std::vector<float> data;
};
} // namespace

std::vector<float>
interpolatePosEmbed(const std::vector<float>& table, int grid, int ph, int pw) {
  // DINOv2 returns the stored table unchanged at its own square grid; the
  // resampling below is not an identity there.
  if (ph == grid && pw == grid)
    return table;
  const int mDim = grid;
  const int64_t dDim = static_cast<int64_t>(table.size()) / (1 + mDim * mDim);
  // DINOv2 passes scale_factor = (n + offset) / M and PyTorch derives the
  // source index from that scale, not from the size ratio.
  auto ty = cubicTaps(
      mDim, ph, (static_cast<double>(ph) + POS_INTERPOLATE_OFFSET) / mDim);
  auto tx = cubicTaps(
      mDim, pw, (static_cast<double>(pw) + POS_INTERPOLATE_OFFSET) / mDim);
  std::vector<float> out(static_cast<size_t>(1 + ph * pw) * dDim);
  std::copy(table.begin(), table.begin() + dDim, out.begin());
  const float* src = table.data() + dDim;
  for (int y = 0; y < ph; ++y) {
    for (int x = 0; x < pw; ++x) {
      float* dst = out.data() + static_cast<size_t>(1 + y * pw + x) * dDim;
      for (int64_t d = 0; d < dDim; ++d) {
        float acc = 0.0f;
        for (int i = 0; i < 4; ++i) {
          float accx = 0.0f;
          for (int j = 0; j < 4; ++j) {
            accx += tx[x].w[j] *
                    src[(ty[y].idx[i] * mDim + tx[x].idx[j]) * dDim + d];
          }
          acc += ty[y].w[i] * accx;
        }
        dst[d] = acc;
      }
    }
  }
  return out;
}

struct BridgeDepthGraph::Impl {
  using Outputs = std::vector<std::pair<std::string, T*>>;
  ggml_context* wctx = nullptr;
  gguf_context* gctx = nullptr;
  ggml_backend_t backend = nullptr;
  ggml_backend_t cpu = nullptr;
  ggml_backend_buffer_t wbuf = nullptr;
  // Measure mode: stands in for wbuf.
  EmptyWeightBuffers emptyWeights;
  ggml_backend_sched_t sched = nullptr;
  int fallbackNodes = 0;
  // Measure mode: the weights have no data, run() sizes the graph instead of
  // computing it and records the result here.
  bool measureOnly = false;
  BufferFootprint measured;
  // Compute buffers and CPU workspace after the last run.
  BufferFootprint allocated;
  uint64_t measuredRunHostBytes = 0; // host inputs and outputs of one run
  uint64_t readBufferBytes = 0;      // largest tensor, the load read buffer

  int monoDepth = 12;
  int monoHeads = 6;
  int refineWindowSize = 4;
  int numRefineLayers = 5;
  std::vector<int> monoLayers;
  int posGrid = 37;
  std::vector<float> posEmbedHost; // [1 + M*M, D], torch layout
  // Shape of pos_embed: D and 1 + M*M. Measure mode keeps no host copy.
  int64_t posDim = 0;
  int64_t posRows = 0;
  std::map<std::pair<int, int>, std::vector<float>> posCache;

  ~Impl() {
    if (sched)
      ggml_backend_sched_free(sched);
    if (wbuf)
      ggml_backend_buffer_free(wbuf);
    if (wctx)
      ggml_free(wctx);
    if (gctx)
      gguf_free(gctx);
  }

  T* weight(const std::string& name) const {
    T* t = ggml_get_tensor(wctx, name.c_str());
    if (!t) {
      throw std::runtime_error("BridgeDepth: missing tensor " + name);
    }
    return t;
  }

  uint32_t kvU32(const char* key) const {
    const int64_t id = gguf_find_key(gctx, key);
    if (id < 0 || gguf_get_kv_type(gctx, id) != GGUF_TYPE_UINT32) {
      throw std::runtime_error(
          std::string("BridgeDepth: missing or non-u32 kv ") + key);
    }
    return gguf_get_val_u32(gctx, id);
  }

  std::vector<int> kvI32Array(const char* key) const {
    const int64_t id = gguf_find_key(gctx, key);
    if (id < 0 || gguf_get_kv_type(gctx, id) != GGUF_TYPE_ARRAY ||
        gguf_get_arr_type(gctx, id) != GGUF_TYPE_INT32) {
      throw std::runtime_error(
          std::string("BridgeDepth: missing or non-i32 array kv ") + key);
    }
    const auto* d = static_cast<const int32_t*>(gguf_get_arr_data(gctx, id));
    return std::vector<int>(d, d + gguf_get_arr_n(gctx, id));
  }

  // Graph inputs registered with their host data, uploaded after allocation.
  // In measure mode (shapesOnly) the host data is not built: an input takes
  // its type and shape only, and its bytes are counted as host memory a run
  // would hold.
  struct Inputs {
    struct Item {
      T* t;
      const void* data;
      size_t bytes;
    };
    std::vector<Item> list;
    bool shapesOnly = false;
    T* addRaw(
        ggml_context* ctx, const char* name, ggml_type type, const void* data,
        size_t bytes, int64_t n0, int64_t n1, int64_t n2, int64_t n3) {
      T* t = ggml_new_tensor_4d(ctx, type, n0, n1, n2, n3);
      ggml_set_name(t, name);
      ggml_set_input(t);
      if (shapesOnly) {
        list.push_back({t, nullptr, ggml_nbytes(t)});
        return t;
      }
      if (bytes != ggml_nbytes(t)) {
        throw std::runtime_error(
            std::string("BridgeDepth: input size mismatch ") + name);
      }
      list.push_back({t, data, bytes});
      return t;
    }
    T*
    add(ggml_context* ctx, const char* name, const std::vector<float>& data,
        int64_t n0, int64_t n1 = 1, int64_t n2 = 1, int64_t n3 = 1) {
      return addRaw(
          ctx,
          name,
          GGML_TYPE_F32,
          data.data(),
          data.size() * sizeof(float),
          n0,
          n1,
          n2,
          n3);
    }
    T* addI32(
        ggml_context* ctx, const char* name, const std::vector<int32_t>& data,
        int64_t n0, int64_t n1 = 1, int64_t n2 = 1, int64_t n3 = 1) {
      return addRaw(
          ctx,
          name,
          GGML_TYPE_I32,
          data.data(),
          data.size() * sizeof(int32_t),
          n0,
          n1,
          n2,
          n3);
    }
  };
  // One graph run: `build` creates inputs (registered with their host data) and
  // returns named outputs; every output is copied back in torch layout.
  std::map<std::string, HostTensor>
  run(const std::function<Outputs(ggml_context*, Inputs&)>& build) {
    ggml_init_params ip{};
    ip.mem_size = ggml_tensor_overhead() * GRAPH_SIZE +
                  ggml_graph_overhead_custom(GRAPH_SIZE, false);
    ip.no_alloc = true;
    std::unique_ptr<ggml_context, decltype(&ggml_free)> owned(
        ggml_init(ip), ggml_free);
    if (!owned)
      throw ResourceError("BridgeDepth: graph context allocation failed");
    ggml_context* ctx = owned.get();
    ggml_cgraph* gf = ggml_new_graph_custom(ctx, GRAPH_SIZE, false);
    Inputs inputs;
    inputs.shapesOnly = measureOnly;
    Outputs outs = build(ctx, inputs);
    for (auto& [name, t] : outs) {
      t = ggml_cont(ctx, t);
      ggml_set_output(t);
      ggml_build_forward_expand(gf, t);
    }
    if (measureOnly) {
      if (!measureSchedulerBuffers(sched, gf, backend, cpu, measured))
        throw ResourceError("BridgeDepth: graph measurement failed");
      measuredRunHostBytes = 0;
      for (const auto& item : inputs.list)
        measuredRunHostBytes += item.bytes;
      for (const auto& [name, t] : outs)
        measuredRunHostBytes += ggml_nbytes(t);
      return {};
    }
    ggml_backend_sched_reset(sched);
    if (!ggml_backend_sched_alloc_graph(sched, gf)) {
      throw ResourceError("BridgeDepth: graph allocation failed");
    }
    for (auto& item : inputs.list) {
      if (item.t->buffer)
        ggml_backend_tensor_set(
            item.t, item.data, 0, item.bytes); // unused inputs stay unallocated
    }
    if (ggml_backend_sched_graph_compute(sched, gf) != GGML_STATUS_SUCCESS) {
      throw std::runtime_error("BridgeDepth: graph compute failed");
    }
    allocated = schedulerBuffers(sched, backend, cpu);
    fallbackNodes = 0;
    if (backend != cpu) {
      // Reshapes and views of host inputs sit on the CPU backend without
      // computing anything, so only ops that do work are counted.
      for (int i = 0; i < ggml_graph_n_nodes(gf); ++i) {
        T* node = ggml_graph_node(gf, i);
        const bool layoutOnly =
            node->op == GGML_OP_NONE || node->op == GGML_OP_RESHAPE ||
            node->op == GGML_OP_VIEW || node->op == GGML_OP_PERMUTE ||
            node->op == GGML_OP_TRANSPOSE;
        if (!layoutOnly &&
            ggml_backend_sched_get_tensor_backend(sched, node) == cpu)
          ++fallbackNodes;
      }
    }
    std::map<std::string, HostTensor> result;
    for (auto& [name, t] : outs) {
      HostTensor h;
      int nd = ggml_n_dims(t);
      for (int i = nd - 1; i >= 0; --i)
        h.shape.push_back(t->ne[i]);
      h.data.resize(ggml_nelements(t));
      ggml_backend_tensor_get(t, h.data.data(), 0, ggml_nbytes(t));
      result.emplace(name, std::move(h));
    }
    return result;
  }

  // interpolatePosEmbed for a ph x pw patch grid, cached per grid.
  const std::vector<float>& posEmbed(int ph, int pw) {
    auto it = posCache.find({ph, pw});
    if (it != posCache.end())
      return it->second;
    std::vector<float> out = interpolatePosEmbed(posEmbedHost, posGrid, ph, pw);
    if (posCache.size() >= POS_CACHE_LIMIT)
      posCache.clear(); // callers may cycle through many sizes
    return posCache.emplace(std::make_pair(ph, pw), std::move(out))
        .first->second;
  }

  // The whole inference as one run(). In measure mode `left` and `right` are
  // null, nothing is computed and the result is empty.
  std::vector<float> forward(
      const float* left, const float* right, int h, int w,
      const std::vector<float>* seedsOverride);

  // ---- mono branch: DAv2 ViT-S + DPT head + depth_feature_down ----

  T* vitBlock(ggml_context* ctx, T* x, int l) {
    const std::string p = "mono.pretrained.blocks." + std::to_string(l) + ".";
    const int64_t dDim = x->ne[0], nDim = x->ne[1], nHeads = monoHeads,
                  dHead = dDim / nHeads;
    T* h = layerNorm(
        ctx, x, weight(p + "norm1.weight"), weight(p + "norm1.bias"), 1e-6f);
    T* qkv = linear(
        ctx, h, weight(p + "attn.qkv.weight"), weight(p + "attn.qkv.bias"));
    auto head = [&](int i) { // [Dh, Hh, N] view of q/k/v, then [Dh, N, Hh]
      T* v = ggml_view_3d(
          ctx,
          qkv,
          dHead,
          nHeads,
          nDim,
          dHead * sizeof(float),
          qkv->nb[1],
          i * dDim * sizeof(float));
      return ggml_cont(ctx, ggml_permute(ctx, v, 0, 2, 1, 3));
    };
    T* q = head(0);
    T* k = head(1);
    T* v = head(2);
    T* kq = ggml_mul_mat(ctx, k, q); // [Nk, Nq, Hh]
    kq = ggml_soft_max_ext(
        ctx, kq, nullptr, 1.0f / std::sqrt(static_cast<float>(dHead)), 0.0f);
    T* vt = ggml_cont(ctx, ggml_transpose(ctx, v)); // [N, Dh, Hh]
    T* o = ggml_mul_mat(ctx, vt, kq);               // [Dh, Nq, Hh]
    o = ggml_cont(ctx, ggml_permute(ctx, o, 0, 2, 1, 3));
    o = ggml_reshape_2d(ctx, o, dDim, nDim);
    o = linear(
        ctx, o, weight(p + "attn.proj.weight"), weight(p + "attn.proj.bias"));
    x = ggml_add(ctx, x, ggml_mul(ctx, o, weight(p + "ls1.gamma")));
    h = layerNorm(
        ctx, x, weight(p + "norm2.weight"), weight(p + "norm2.bias"), 1e-6f);
    h = linear(
        ctx, h, weight(p + "mlp.fc1.weight"), weight(p + "mlp.fc1.bias"));
    h = ggml_gelu_erf(ctx, h);
    h = linear(
        ctx, h, weight(p + "mlp.fc2.weight"), weight(p + "mlp.fc2.bias"));
    return ggml_add(ctx, x, ggml_mul(ctx, h, weight(p + "ls2.gamma")));
  }

  // ResidualConvUnit: conv2(relu(conv1(relu(x)))) + x, ReLU not in place.
  T* rcu(ggml_context* ctx, T* x, const std::string& p) {
    T* h = ggml_relu(ctx, x);
    h = conv2d(
        ctx, h, weight(p + "conv1.weight"), weight(p + "conv1.bias"), 1, 1);
    h = ggml_relu(ctx, h);
    h = conv2d(
        ctx, h, weight(p + "conv2.weight"), weight(p + "conv2.bias"), 1, 1);
    return ggml_add(ctx, h, x);
  }

  // FeatureFusionBlock. Mono (DPT) uses align_corners=True and scale 2 when no
  // size is given; stereo uses align_corners=False and skips the resize.
  T* fusion(
      ggml_context* ctx, const std::string& p, T* x0, T* x1, T* sizeLike,
      bool mono) {
    T* out = x0;
    if (x1)
      out = ggml_add(ctx, out, rcu(ctx, x1, p + "resConfUnit1."));
    out = rcu(ctx, out, p + "resConfUnit2.");
    if (sizeLike) {
      out = bilinear(ctx, out, sizeLike->ne[0], sizeLike->ne[1], mono);
    } else if (mono) {
      out = bilinear(ctx, out, out->ne[0] * 2, out->ne[1] * 2, true);
    }
    return conv2d(
        ctx,
        out,
        weight(p + "out_conv.weight"),
        weight(p + "out_conv.bias"),
        1,
        0);
  }

  Outputs buildMono(
      ggml_context* ctx, T* img /* [wDim,hDim,3,1] padded, 0..255 */, T* mean,
      T* stdv, T* pos, int ph, int pw) {
    Outputs outs;
    const int64_t hDim = img->ne[1], wDim = img->ne[0];
    T* x = bilinear(ctx, img, wDim / 8 * 7, hDim / 8 * 7, false);
    x = ggml_div(ctx, ggml_sub(ctx, x, mean), stdv);
    outs.emplace_back("mono.input_normalized", x);

    const std::string vp = "mono.pretrained.";
    T* t = conv2d(
        ctx,
        x,
        weight(vp + "patch_embed.proj.weight"),
        weight(vp + "patch_embed.proj.bias"),
        14,
        0); // [pw, ph, D, 1]
    const int64_t dDim = t->ne[2], nPad = static_cast<int64_t>(pw) * ph;
    t = ggml_cont(
        ctx,
        ggml_transpose(ctx, ggml_reshape_2d(ctx, t, nPad, dDim))); // [D, Np]
    T* cls = ggml_reshape_2d(ctx, weight(vp + "cls_token"), dDim, 1);
    t = ggml_concat(ctx, cls, t, 1);
    t = ggml_add(ctx, t, pos);

    std::vector<T*> feats;
    for (int l = 0; l < monoDepth; ++l) {
      t = vitBlock(ctx, t, l);
      if (std::find(monoLayers.begin(), monoLayers.end(), l) !=
          monoLayers.end()) {
        T* f = layerNorm(
            ctx,
            t,
            weight(vp + "norm.weight"),
            weight(vp + "norm.bias"),
            1e-6f);
        f = ggml_view_2d(ctx, f, dDim, nPad, f->nb[1], f->nb[1]); // drop cls
        f = ggml_cont(ctx, ggml_transpose(ctx, f));               // [Np, D]
        feats.push_back(ggml_reshape_4d(ctx, f, pw, ph, dDim, 1));
      }
    }

    const std::string hp = "mono.depth_head.";
    std::vector<T*> layers(4);
    for (int i = 0; i < 4; ++i) {
      const std::string pi = std::to_string(i);
      T* f = conv2d(
          ctx,
          feats[i],
          weight(hp + "projects." + pi + ".weight"),
          weight(hp + "projects." + pi + ".bias"),
          1,
          0);
      if (i == 0) {
        f = convTransposeKS(
            ctx,
            f,
            weight(hp + "resize_layers.0.weight"),
            weight(hp + "resize_layers.0.bias"),
            4);
      } else if (i == 1) {
        f = convTransposeKS(
            ctx,
            f,
            weight(hp + "resize_layers.1.weight"),
            weight(hp + "resize_layers.1.bias"),
            2);
      } else if (i == 3) {
        f = conv2d(
            ctx,
            f,
            weight(hp + "resize_layers.3.weight"),
            weight(hp + "resize_layers.3.bias"),
            2,
            1);
      }
      layers[i] = conv2d(
          ctx,
          f,
          weight(hp + "scratch.layer" + std::to_string(i + 1) + "_rn.weight"),
          nullptr,
          1,
          1);
    }
    const std::string sp = hp + "scratch.";
    T* p4 =
        fusion(ctx, sp + "refinenet4.", layers[3], nullptr, layers[2], true);
    T* p3 = fusion(ctx, sp + "refinenet3.", p4, layers[2], layers[1], true);
    T* p2 = fusion(ctx, sp + "refinenet2.", p3, layers[1], layers[0], true);
    T* p1 = fusion(ctx, sp + "refinenet1.", p2, layers[0], nullptr, true);
    T* dpt = conv2d(
        ctx,
        p1,
        weight(sp + "output_conv1.weight"),
        weight(sp + "output_conv1.bias"),
        1,
        1);
    outs.emplace_back("mono.dpt_out", dpt);

    T* prior = conv2d(
        ctx,
        dpt,
        weight("depth_feature_down.weight"),
        weight("depth_feature_down.bias"),
        4,
        0);
    outs.emplace_back(
        "depth_prior", toChannelsFirst(ctx, prior)); // NHWC like torch
    return outs;
  }

  // ---- stereo backbone: torchvision ConvNeXt-T (3 stages) + DPT-style fusion
  // ----

  T* layerNorm2d(ggml_context* ctx, T* x, const std::string& p) {
    T* c = toChannelsFirst(ctx, x);
    c = layerNorm(ctx, c, weight(p + "weight"), weight(p + "bias"), 1e-6f);
    return toChannelsLast(ctx, c);
  }

  // torchvision CNBlock: block = [dwconv7, Permute, LayerNorm, Linear, GELU,
  // Linear, Permute]
  T* cnBlock(ggml_context* ctx, T* x, const std::string& p) {
    T* h = convDepthwise(
        ctx, x, weight(p + "block.0.weight"), weight(p + "block.0.bias"), 3);
    h = toChannelsFirst(ctx, h);
    h = layerNorm(
        ctx,
        h,
        weight(p + "block.2.weight"),
        weight(p + "block.2.bias"),
        1e-6f);
    h = linear(
        ctx, h, weight(p + "block.3.weight"), weight(p + "block.3.bias"));
    h = ggml_gelu_erf(ctx, h);
    h = linear(
        ctx, h, weight(p + "block.5.weight"), weight(p + "block.5.bias"));
    T* ls = weight(p + "layer_scale");
    h = ggml_mul(ctx, h, ggml_reshape_1d(ctx, ls, ggml_nelements(ls)));
    return ggml_add(ctx, x, toChannelsLast(ctx, h));
  }

  T* concatOrGw(ggml_context* ctx, T* x, const std::string& p) {
    T* h = conv2d(ctx, x, weight(p + "0.weight"), nullptr, 1, 1);
    // InstanceNorm2d. Batch is folded into channels: Metal's GROUP_NORM kernel
    // only normalises ne3 = 0 and leaves the other batch entries unwritten.
    const int64_t c = h->ne[2], b = h->ne[3];
    h = ggml_reshape_4d(ctx, h, h->ne[0], h->ne[1], c * b, 1);
    h = ggml_group_norm(ctx, h, static_cast<int>(c * b), 1e-5f);
    h = ggml_reshape_4d(ctx, h, h->ne[0], h->ne[1], c, b);
    h = ggml_relu(ctx, h);
    return conv2d(ctx, h, weight(p + "3.weight"), nullptr, 1, 0);
  }

  Outputs buildStereoFeatures(
      ggml_context* ctx, T* imgs /* [wDim,hDim,3,2] */, T* mean, T* stdv) {
    Outputs outs;
    const std::string bp = "stereo.backbone.";
    const std::string fp = bp + "features.";
    T* x = ggml_div(ctx, ggml_sub(ctx, imgs, mean), stdv);
    x = conv2d(
        ctx, x, weight(fp + "0.0.weight"), weight(fp + "0.0.bias"), 4, 0);
    x = layerNorm2d(ctx, x, fp + "0.1.");
    const int nBlocks[3] = {3, 3, 9};
    std::vector<T*> feats;
    for (int s = 0; s < 3; ++s) {
      const int idx = 1 + 2 * s;
      if (s > 0) {
        const std::string dp = fp + std::to_string(idx - 1) + ".";
        x = layerNorm2d(ctx, x, dp + "0.");
        x = conv2d(
            ctx, x, weight(dp + "1.weight"), weight(dp + "1.bias"), 2, 0);
      }
      for (int b = 0; b < nBlocks[s]; ++b) {
        x = cnBlock(
            ctx, x, fp + std::to_string(idx) + "." + std::to_string(b) + ".");
      }
      feats.push_back(
          layerNorm2d(ctx, x, bp + "norms." + std::to_string(s) + "."));
    }
    const std::string sp = bp + "scratch.";
    T* l1 =
        conv2d(ctx, feats[0], weight(sp + "layer1_rn.weight"), nullptr, 1, 1);
    T* l2 =
        conv2d(ctx, feats[1], weight(sp + "layer2_rn.weight"), nullptr, 1, 1);
    T* l3 =
        conv2d(ctx, feats[2], weight(sp + "layer3_rn.weight"), nullptr, 1, 1);
    T* p3 = fusion(ctx, sp + "refinenet3.", l3, nullptr, l2, false);
    T* p2 = fusion(ctx, sp + "refinenet2.", p3, l2, l1, false);
    T* p1 = fusion(ctx, sp + "refinenet1.", p2, l1, nullptr, false);
    T* q8 = ggml_pool_2d(ctx, p1, GGML_OP_POOL_AVG, 2, 2, 2, 2, 0, 0);

    struct Res {
      const char* tag;
      T* t;
    } res[2] = {{"1_8", q8}, {"1_4", p1}};
    for (auto& r : res) {
      T* cc = concatOrGw(ctx, r.t, "stereo.concatconv.");
      T* gw = concatOrGw(ctx, r.t, "stereo.gw.");
      for (int i = 0; i < 2; ++i) {
        const std::string img = std::to_string(i + 1) + "_" + r.tag;
        outs.emplace_back("backbone.fmap" + img, batchSlice(ctx, r.t, i));
        outs.emplace_back("concatconv" + img, batchSlice(ctx, cc, i));
        outs.emplace_back("gw" + img, batchSlice(ctx, gw, i));
      }
    }
    return outs;
  }

  // ---- phase 3: cost volume, DPN seeds, propagation, proposals ----

  int numDisp = 40;
  int costGroup = 4;
  int numProposals = 2;
  int propHeads = 4;
  int numPropLayers = 5;

  // Group-wise correlation volume. f1, f2 are [W, H, C, 1]. Returns ggml
  // [W, D, H, G] with vol[w, d, h, g] = mean over the group of f1[w] * f2[w -
  // d], zero for w < d. f2 is padded on the left by D - 1 zero columns once, so
  // the shift for each d is a plain offset view and the zeros come for free.
  // One strided view over all d would be cheaper but ggml_view rejects views
  // whose dense size exceeds the source.
  T* costVolume(ggml_context* ctx, T* f1, T* f2, T* avg /* [cDim, gDim] */) {
    const int64_t wDim = f1->ne[0], hDim = f1->ne[1], cDim = f1->ne[2],
                  dDim = numDisp;
    T* f1c = toChannelsFirst(ctx, f1); // [C, W, H, 1]
    T* f2p = padFront(
        ctx,
        toChannelsFirst(ctx, f2),
        0,
        static_cast<int>(dDim - 1)); // [C, W + D - 1, H, 1]
    std::vector<T*> slices;
    for (int64_t d = 0; d < dDim; ++d) {
      T* shifted = ggml_view_3d(
          ctx,
          f2p,
          cDim,
          wDim,
          hDim,
          f2p->nb[1],
          f2p->nb[2],
          (dDim - 1 - d) * f2p->nb[1]);
      T* prod = ggml_mul(ctx, shifted, f1c); // [C, W, H]
      T* corr = ggml_mul_mat(
          ctx, ggml_reshape_2d(ctx, prod, cDim, wDim * hDim), avg); // [W*H, G]
      slices.push_back(ggml_reshape_4d(ctx, corr, wDim, 1, hDim, costGroup));
    }
    return concatAll(ctx, slices, 1); // [W, D, H, G]
  }

  // One CSWinAttention branch of a CSWinNMP layer. q, k, v are [64, N, W, H];
  // idx 0 attends within columns (window = one w, tokens (h, n)), idx 1 within
  // rows (window = one h, tokens (w, n)). mask is [T, T] with -inf between the
  // N proposals of the same pixel.
  T* cswinAttention(
      ggml_context* ctx, T* q, T* k, T* v, T* mask, T* getVw, int idx) {
    const int64_t cDim = q->ne[0], nDim = q->ne[1], wDim = q->ne[2],
                  hDim = q->ne[3];
    const int64_t heads = propHeads / 2, dHead = cDim / heads;
    auto toWindows = [&](T* t) { // [C, N, W, H] -> [Dh, T, heads, windows]
      if (idx == 0)
        t = ggml_cont(ctx, ggml_permute(ctx, t, 0, 1, 3, 2)); // [C, N, H, W]
      const int64_t tokRows = idx == 0 ? nDim * hDim : nDim * wDim;
      const int64_t nWin = idx == 0 ? wDim : hDim;
      t = ggml_reshape_4d(ctx, t, dHead, heads, tokRows, nWin);
      return ggml_cont(ctx, ggml_permute(ctx, t, 0, 2, 1, 3));
    };
    T* qw = toWindows(q);
    T* kw = toWindows(k);
    T* vw = toWindows(v);
    T* kq = ggml_mul_mat(ctx, kw, qw); // [Tk, Tq, heads, windows]
    kq = ggml_soft_max_ext(
        ctx, kq, mask, 1.0f / std::sqrt(static_cast<float>(dHead)), 0.0f);
    T* vt = ggml_cont(ctx, ggml_transpose(ctx, vw));
    T* o = ggml_mul_mat(ctx, vt, kq); // [Dh, Tq, heads, windows]
    o = ggml_cont(
        ctx, ggml_permute(ctx, o, 0, 2, 1, 3)); // [Dh, heads, T, windows]
    if (idx == 0) {
      o = ggml_reshape_4d(ctx, o, cDim, nDim, hDim, wDim);
      o = ggml_cont(ctx, ggml_permute(ctx, o, 0, 1, 3, 2));
    } else {
      o = ggml_reshape_4d(ctx, o, cDim, nDim, wDim, hDim);
    }
    // get_rpe: depthwise 3x3 over the value image of each proposal, summed over
    // the proposals, minus the centre tap of the other proposals (self edges
    // carry no positional term).
    T* vimg = ggml_cont(ctx, ggml_permute(ctx, v, 2, 3, 0, 1)); // [W, H, C, N]
    T* conv = ggml_conv_2d_dw_direct(ctx, getVw, vimg, 1, 1, 1, 1, 1, 1);
    T* convSum = batchSlice(ctx, conv, 0);
    for (int n = 1; n < nDim; ++n)
      convSum = ggml_add(ctx, convSum, batchSlice(ctx, conv, n));
    T* centre = ggml_view_4d(
        ctx,
        getVw,
        1,
        1,
        1,
        cDim,
        getVw->nb[1],
        getVw->nb[2],
        getVw->nb[3],
        getVw->nb[0] + getVw->nb[1]);
    centre = ggml_reshape_4d(ctx, ggml_cont(ctx, centre), 1, 1, cDim, 1);
    T* ss = ggml_mul(ctx, vimg, centre); // [W, H, C, N]
    T* ssSum = batchSlice(ctx, ss, 0);
    for (int n = 1; n < nDim; ++n)
      ssSum = ggml_add(ctx, ssSum, batchSlice(ctx, ss, n));
    T* rpe = ggml_add(ctx, ggml_sub(ctx, ss, ssSum), convSum); // [W, H, C, N]
    rpe = ggml_cont(ctx, ggml_permute(ctx, rpe, 2, 3, 0, 1));  // [C, N, W, H]
    return ggml_add(ctx, o, rpe);
  }

  // CSWinNMP: x [128, N, W, H], context [64, N, W, H].
  T* cswinLayer(
      ggml_context* ctx, T* x, T* context, T* maskCol, T* maskRow,
      const std::string& p) {
    const int64_t cDim = x->ne[0], half = cDim / 2;
    T* xn = layerNorm(
        ctx, x, weight(p + "norm1.weight"), weight(p + "norm1.bias"), 1e-6f);
    T* qk = ggml_concat(ctx, xn, context, 0);
    T* q = linear(ctx, qk, weight(p + "q.weight"), weight(p + "q.bias"));
    T* k = linear(ctx, qk, weight(p + "k.weight"), weight(p + "k.bias"));
    T* v = linear(ctx, xn, weight(p + "v.weight"), weight(p + "v.bias"));
    T* x1 = cswinAttention(
        ctx,
        channelSlice(ctx, q, 0, half),
        channelSlice(ctx, k, 0, half),
        channelSlice(ctx, v, 0, half),
        maskCol,
        weight(p + "attns.0.get_v.weight"),
        0);
    T* x2 = cswinAttention(
        ctx,
        channelSlice(ctx, q, half, half),
        channelSlice(ctx, k, half, half),
        channelSlice(ctx, v, half, half),
        maskRow,
        weight(p + "attns.1.get_v.weight"),
        1);
    T* a = ggml_concat(ctx, x1, x2, 0);
    a = linear(ctx, a, weight(p + "proj.weight"), weight(p + "proj.bias"));
    x = ggml_add(ctx, x, a);
    T* h = layerNorm(
        ctx, x, weight(p + "norm2.weight"), weight(p + "norm2.bias"), 1e-6f);
    h = linear(
        ctx, h, weight(p + "mlp.fc1.weight"), weight(p + "mlp.fc1.bias"));
    h = ggml_gelu_erf(ctx, h);
    h = linear(
        ctx, h, weight(p + "mlp.fc2.weight"), weight(p + "mlp.fc2.bias"));
    return ggml_add(ctx, x, h);
  }

  // fourier_coord_embed(coord, N_freqs=15, normalizer): coord [1, N, ...] ->
  // [31, N, ...] = cat(sin(c f), cos(c f), c), c = coord * normalizer.
  T* fourierEmbed(
      ggml_context* ctx, T* coord, T* freqs /* [15] */, float normalizer) {
    T* c = ggml_scale(ctx, coord, normalizer);
    T* f = ggml_repeat_4d(
        ctx,
        ggml_reshape_4d(ctx, freqs, freqs->ne[0], 1, 1, 1),
        freqs->ne[0],
        c->ne[1],
        c->ne[2],
        c->ne[3]);
    T* cf = ggml_mul(ctx, f, c);
    return ggml_concat(
        ctx, ggml_concat(ctx, ggml_sin(ctx, cf), ggml_cos(ctx, cf), 0), c, 0);
  }

  // Head(in, hidden, out, 3): Linear, ReLU, Linear, ReLU, Linear.
  T* head3(ggml_context* ctx, T* x, const std::string& p) {
    x = ggml_relu(
        ctx,
        linear(
            ctx,
            x,
            weight(p + "layers.0.weight"),
            weight(p + "layers.0.bias")));
    x = ggml_relu(
        ctx,
        linear(
            ctx,
            x,
            weight(p + "layers.1.weight"),
            weight(p + "layers.1.bias")));
    return linear(
        ctx, x, weight(p + "layers.2.weight"), weight(p + "layers.2.bias"));
  }

  struct DpnInputs {
    T* avg;     // [128, 4] block average, 1/32 entries
    T* arange;  // [1, D] values 0..D-1, for the I32 -> F32 seed conversion
    T* offsets; // [9] -4..4
    T* freqs;   // [15] 2^0..2^14
    T* maskCol; // [N*H, N*H]
    T* maskRow; // [N*W, N*W]
    T* seedsOverride =
        nullptr; // [N, HW] float seeds from the reference, test only
  };

  // fmap1, fmap2: backbone 1/8 maps [W, H, 128, 1]; prior: depth_prior [128, W,
  // H, 1].
  Outputs buildDpn(
      ggml_context* ctx, T* fmap1, T* fmap2, T* prior, const DpnInputs& in) {
    Outputs outs;
    const int64_t wDim = fmap1->ne[0], hDim = fmap1->ne[1], hwDim = wDim * hDim,
                  dDim = numDisp, gDim = costGroup, nDim = numProposals;
    T* vol = costVolume(ctx, fmap1, fmap2, in.avg); // [W, D, H, G]
    outs.emplace_back(
        "cost_volume",
        ggml_permute(ctx, vol, 0, 2, 1, 3)); // torch [G, D, H, W]
    T* volRows =
        ggml_cont(ctx, ggml_permute(ctx, vol, 2, 1, 3, 0)); // [G, D, W, H]
    volRows = ggml_reshape_3d(ctx, volRows, gDim, dDim, hwDim);
    T* volD =
        ggml_cont(ctx, ggml_permute(ctx, volRows, 1, 0, 2, 3)); // [D, G, HW]

    const std::string dp = "stereo.dpn.";
    T* cost = ggml_relu(
        ctx,
        conv1d(
            ctx,
            volD,
            weight(dp + "mlp.0.weight"),
            weight(dp + "mlp.0.bias"),
            2));
    cost = ggml_relu(
        ctx,
        conv1d(
            ctx,
            cost,
            weight(dp + "mlp.2.weight"),
            weight(dp + "mlp.2.bias"),
            2));
    cost = conv1d(
        ctx,
        cost,
        weight(dp + "mlp.4.weight"),
        weight(dp + "mlp.4.bias"),
        2); // [D, 1, HW]
    cost = ggml_reshape_2d(ctx, cost, dDim, hwDim);
    T* prob = ggml_soft_max(ctx, cost);
    outs.emplace_back("dpn.prob", prob);

    // Local maxima of prob along D, torch: max_pool1d(3, 1, 1) then prob !=
    // out. Exact version without the pool: a neighbour is strictly larger. Zero
    // padding is equivalent to torch's -inf padding because prob >= 0.
    const float eps = 1e-3f;
    T* left = padFront(
        ctx,
        ggml_cont(
            ctx, ggml_view_2d(ctx, prob, dDim - 1, hwDim, prob->nb[1], 0)),
        1,
        0);
    T* right = ggml_pad_ext(
        ctx,
        ggml_cont(
            ctx,
            ggml_view_2d(ctx, prob, dDim - 1, hwDim, prob->nb[1], prob->nb[0])),
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        0);
    T* bigger = ggml_add(
        ctx,
        ggml_step(ctx, ggml_sub(ctx, left, prob)),
        ggml_step(ctx, ggml_sub(ctx, right, prob)));
    T* nonLocal = ggml_mul(
        ctx,
        ggml_step(ctx, bigger),
        ggml_step(ctx, ggml_scale_bias(ctx, prob, 1.0f, -eps)));
    // torch sets non-maxima to exactly eps, so most rows have several entries
    // tied at eps, and torch.topk takes the lowest index among them. ggml's
    // top_k has no tie order, and a per-pixel mix of tie choices costs
    // accuracy: on ETH3D, torch with a random tie-break per pixel moves bad 1.0
    // from 1.61% to 1.76%, while one fixed rule (lowest or highest index) does
    // not. So the masked value is eps minus one float32 ulp of eps per index:
    // exact (prob - prob is 0, the steps stay in eps's binade), distinct, and
    // highest at the lowest index. An unmasked value within D (40) ulp below
    // eps, about 5e-9, would sort differently from torch.
    const float tieStep = std::ldexp(1.0f, -33); // float32 ulp in [2^-10, 2^-9)
    T* tieValue = ggml_scale_bias(
        ctx, ggml_reshape_1d(ctx, in.arange, dDim), -tieStep, eps); // [D]
    T* probMasked = ggml_add(
        ctx,
        ggml_sub(ctx, prob, ggml_mul(ctx, nonLocal, prob)),
        ggml_mul(ctx, nonLocal, tieValue));
    outs.emplace_back("dpn.prob_masked", probMasked);
    T* seeds;
    if (in.seedsOverride) {
      seeds = ggml_reshape_3d(ctx, in.seedsOverride, 1, nDim, hwDim);
    } else {
      T* seedsI = ggml_top_k(
          ctx, probMasked, static_cast<int>(nDim)); // I32 [N, HW], unordered
      seeds = ggml_get_rows(
          ctx,
          in.arange,
          ggml_reshape_1d(ctx, seedsI, nDim * hwDim)); // [1, N*HW] F32
      seeds = ggml_reshape_3d(ctx, seeds, 1, nDim, hwDim);
    }
    outs.emplace_back("dpn.seeds", ggml_reshape_2d(ctx, seeds, nDim, hwDim));

    // sample_corr: 9 cost values around each seed, feature order g*9 + offset.
    T* idx = ggml_add(
        ctx,
        ggml_repeat_4d(
            ctx,
            ggml_reshape_4d(ctx, in.offsets, 9, 1, 1, 1),
            9,
            nDim,
            hwDim,
            1),
        seeds);
    idx = ggml_clamp(ctx, idx, 0.0f, static_cast<float>(dDim - 1));
    T* idxI = ggml_cast(
        ctx, ggml_reshape_2d(ctx, idx, 9 * nDim, hwDim), GGML_TYPE_I32);
    T* corr = ggml_get_rows(ctx, volRows, idxI); // [G, 9*N, HW]
    corr = ggml_reshape_4d(ctx, corr, gDim, 9, nDim, hwDim);
    corr = ggml_cont(ctx, ggml_permute(ctx, corr, 1, 0, 2, 3)); // [9, G, N, HW]
    corr = ggml_reshape_3d(ctx, corr, 9 * gDim, nDim, hwDim);
    const std::string pp = dp + "propagation.";
    corr = linear(
        ctx,
        corr,
        weight(pp + "corr_encoder.0.weight"),
        weight(pp + "corr_encoder.0.bias"));
    corr = ggml_gelu_erf(ctx, corr);
    corr = linear(
        ctx,
        corr,
        weight(pp + "corr_encoder.2.weight"),
        weight(pp + "corr_encoder.2.bias")); // [64, N, HW]

    T* pos = fourierEmbed(ctx, seeds, in.freqs, 3.14f / 64.0f); // [31, N, HW]
    T* priorP = linear(
        ctx,
        ggml_reshape_2d(ctx, prior, prior->ne[0], hwDim),
        weight(dp + "prior_proj.weight"),
        weight(dp + "prior_proj.bias"));
    priorP = ggml_repeat_4d(
        ctx,
        ggml_reshape_3d(ctx, priorP, priorP->ne[0], 1, hwDim),
        priorP->ne[0],
        nDim,
        hwDim,
        1);
    T* x = ggml_concat(
        ctx, ggml_concat(ctx, corr, pos, 0), priorP, 0);  // [159, N, HW]
    x = ggml_mul_mat(ctx, weight(pp + "proj.weight"), x); // [128, N, HW]
    x = ggml_reshape_4d(ctx, x, x->ne[0], nDim, wDim, hDim);

    T* context = ggml_relu(
        ctx, conv2d(ctx, fmap1, weight(dp + "proj.0.weight"), nullptr, 1, 1));
    context = conv2d(
        ctx,
        context,
        weight(dp + "proj.2.weight"),
        nullptr,
        1,
        0);                                  // [W, H, 64, 1]
    context = toChannelsFirst(ctx, context); // [64, W, H, 1]
    context = ggml_repeat_4d(
        ctx,
        ggml_reshape_4d(ctx, context, context->ne[0], 1, wDim, hDim),
        context->ne[0],
        nDim,
        wDim,
        hDim);

    for (int l = 0; l < numPropLayers; ++l) {
      x = cswinLayer(
          ctx,
          x,
          context,
          in.maskCol,
          in.maskRow,
          pp + "layers." + std::to_string(l) + ".nmp.");
    }
    x = layerNorm(
        ctx, x, weight(pp + "norm.weight"), weight(pp + "norm.bias"), 1e-5f);
    T* update = head3(
        ctx,
        ggml_reshape_3d(ctx, x, x->ne[0], nDim, hwDim),
        dp + "prop_head."); // [1, N, HW]
    T* proposal = ggml_relu(
        ctx,
        ggml_add(
            ctx,
            ggml_reshape_2d(ctx, update, nDim, hwDim),
            ggml_reshape_2d(ctx, seeds, nDim, hwDim)));
    outs.emplace_back("dpn.proposal", proposal); // torch [1, HW, N]
    return outs;
  }

  // ---- phase 4: hypothesis embedding, alignment stage 0, heads, disp_est ----
  //
  // Token tensors are ggml [C, N, W, H] for torch [B, H, W, N, C]; the mono
  // embedding is the same with N = 1. Window tokens are ordered (hs, ws, n)
  // with n fastest, which is what folding N into the channel dim gives.

  int inferHeads = 4;
  int windowSize = 6;
  int numInferLayers = 5;
  std::map<std::string, std::vector<int32_t>>
      rpeIndexHost; // relative_position_index per block, inference only
  // Element count of each relative_position_index, in both modes.
  std::map<std::string, int64_t> rpeIndexElems;

  struct AlignInputs {
    T* wIdx;     // [1, 1, W, 1] values 0..W-1
    T* rowBase;  // [1, 1, W, H] values h*W
    T* avg32;    // [256, 32] block average, 1/8 entries
    T* freqs;    // [15]
    T* maskEven; // [T, T] self-edge mask for the unshifted blocks, null when N
                 // = 1
    T* maskOdd;  // [T, T, 1, nW] shifted-window mask plus self edges
    std::vector<T*> idxReadout, idxNmp, idxUpdate; // I32 [Tk*Tq] per layer
  };
  // One AlignInputs per stage: wIdx, rowBase and the masks depend on the
  // resolution and the window; avg32 and freqs are shared.

  // x [C, N, W, H] -> [C, win*win*N, nW], windows ordered (i, j) with j
  // fastest.
  T* windowPartition(ggml_context* ctx, T* x, int win) {
    const int64_t cDim = x->ne[0], nDim = x->ne[1], wPad = x->ne[2],
                  hPad = x->ne[3];
    T* t = ggml_reshape_4d(
        ctx,
        x,
        cDim * nDim * win,
        wPad / win,
        win,
        hPad / win); // [(c,n,ws), j, hs, i]
    t = ggml_cont(
        ctx, ggml_permute(ctx, t, 0, 2, 1, 3)); // [(c,n,ws), hs, j, i]
    return ggml_reshape_3d(
        ctx, t, cDim, nDim * win * win, (wPad / win) * (hPad / win));
  }

  T* windowReverse(
      ggml_context* ctx, T* w, int64_t nDim, int64_t wPad, int64_t hPad,
      int win) {
    const int64_t cDim = w->ne[0];
    T* t = ggml_reshape_4d(
        ctx,
        w,
        cDim * nDim * win,
        win,
        wPad / win,
        hPad / win); // [(c,n,ws), hs, j, i]
    t = ggml_cont(
        ctx, ggml_permute(ctx, t, 0, 2, 1, 3)); // [(c,n,ws), j, hs, i]
    return ggml_reshape_4d(ctx, t, cDim, nDim, wPad, hPad);
  }

  T* padTokens(ggml_context* ctx, T* x, int64_t wPad, int64_t hPad) {
    if (wPad == x->ne[2] && hPad == x->ne[3])
      return x;
    return ggml_pad_ext(
        ctx,
        x,
        0,
        0,
        0,
        0,
        0,
        static_cast<int>(wPad - x->ne[2]),
        0,
        static_cast<int>(hPad - x->ne[3]));
  }

  T* cropTokens(ggml_context* ctx, T* x, int64_t wDim, int64_t hDim) {
    if (wDim == x->ne[2] && hDim == x->ne[3])
      return x;
    return ggml_cont(
        ctx,
        ggml_view_4d(
            ctx,
            x,
            x->ne[0],
            x->ne[1],
            wDim,
            hDim,
            x->nb[1],
            x->nb[2],
            x->nb[3],
            0));
  }

  // Window attention with the three relative-position terms of CrossAttention
  // and WindowAttention: attn = q k + q k_rpe + k q_rpe, out = attn v + attn
  // v_rpe. q [C, Tq, nW], k and v [C, Tk, nW], table [3C, (2w-1)^2] with the 3C
  // laid out (head, {q, k, v}, c), idx I32 [Tk*Tq] already expanded over the M
  // query and N key tokens of a pixel, mask [Tk, Tq, 1, nW] or [Tk, Tq] or
  // null. The rpe terms are batched products over (i, head) or (j, head).
  T* rpeAttention(
      ggml_context* ctx, T* q, T* k, T* v, T* table, T* idx, T* mask) {
    const int64_t cDim = q->ne[0], tokQ = q->ne[1], tokK = k->ne[1],
                  nW = q->ne[2];
    const int64_t nHeads = inferHeads, dHead = cDim / nHeads;
    auto toHeads = [&](T* t) { // [C, T, nW] -> [Dh, T, Hh, nW]
      t = ggml_reshape_4d(ctx, t, dHead, nHeads, t->ne[1], nW);
      return ggml_cont(ctx, ggml_permute(ctx, t, 0, 2, 1, 3));
    };
    T* qh = toHeads(q);
    T* kh = toHeads(k);
    T* vh = toHeads(v);
    T* rDim =
        ggml_get_rows(ctx, table, idx); // [3C, Tk*Tq] = [(h, chunk, c), j, i]
    rDim = ggml_reshape_4d(ctx, rDim, dHead, 3, nHeads, tokK * tokQ);
    auto chunk = [&](int ci) { // -> [c, h, j, i]
      T* t = ggml_view_3d(
          ctx,
          rDim,
          dHead,
          nHeads,
          tokK * tokQ,
          rDim->nb[2],
          rDim->nb[3],
          ci * rDim->nb[1]);
      return ggml_reshape_4d(ctx, ggml_cont(ctx, t), dHead, nHeads, tokK, tokQ);
    };
    T* qRpe = ggml_reshape_3d(
        ctx,
        ggml_cont(ctx, ggml_permute(ctx, chunk(0), 0, 3, 2, 1)),
        dHead,
        tokQ,
        tokK * nHeads); // [c, i, (j, h)]
    T* kRpe = ggml_reshape_3d(
        ctx,
        ggml_cont(ctx, ggml_permute(ctx, chunk(1), 0, 3, 1, 2)),
        dHead,
        tokK,
        tokQ * nHeads); // [c, j, (i, h)]
    T* vRpe = ggml_reshape_3d(
        ctx,
        ggml_cont(ctx, ggml_permute(ctx, chunk(2), 1, 3, 0, 2)),
        tokK,
        dHead,
        tokQ * nHeads); // [j, c, (i, h)]

    // The rpe tables have no window dim. Vulkan runs mul_mat on the CPU when
    // src0 and src1 differ in ne3, so the windows go into src1's ne1 instead
    // of being broadcast: [inner, rows, nW] -> [inner, nW, rows].
    auto windowsAsCols = [&](T* t, int64_t inner, int64_t rows) {
      return ggml_cont(
          ctx,
          ggml_permute(
              ctx, ggml_reshape_3d(ctx, t, inner, rows, nW), 0, 2, 1, 3));
    };
    T* attn = ggml_mul_mat(ctx, kh, qh); // [Tk, Tq, Hh, nW]
    T* qr = ggml_mul_mat(
        ctx, kRpe, windowsAsCols(qh, dHead, tokQ * nHeads)); // [Tk, nW, Tq*Hh]
    qr = ggml_cont(
        ctx,
        ggml_permute(
            ctx, ggml_reshape_4d(ctx, qr, tokK, nW, tokQ, nHeads), 0, 3, 1, 2));
    attn = ggml_add(ctx, attn, qr);
    T* kr = ggml_mul_mat(
        ctx, qRpe, windowsAsCols(kh, dHead, tokK * nHeads)); // [Tq, nW, Tk*Hh]
    kr = ggml_cont(
        ctx,
        ggml_permute(
            ctx, ggml_reshape_4d(ctx, kr, tokQ, nW, tokK, nHeads), 1, 3, 0, 2));
    attn = ggml_add(ctx, attn, kr);
    attn = ggml_soft_max_ext(
        ctx, attn, mask, 1.0f / std::sqrt(static_cast<float>(dHead)), 0.0f);
    T* vt = ggml_cont(ctx, ggml_transpose(ctx, vh)); // [Tk, Dh, Hh, nW]
    T* o = ggml_mul_mat(ctx, vt, attn);              // [Dh, Tq, Hh, nW]
    T* vr = ggml_mul_mat(
        ctx, vRpe, windowsAsCols(attn, tokK, tokQ * nHeads)); // [Dh, nW, Tq*Hh]
    vr = ggml_cont(
        ctx,
        ggml_permute(
            ctx,
            ggml_reshape_4d(ctx, vr, dHead, nW, tokQ, nHeads),
            0,
            3,
            2,
            1));
    o = ggml_cont(ctx, ggml_permute(ctx, o, 0, 2, 1, 3)); // [Dh, Hh, Tq, nW]
    o = ggml_add(ctx, o, vr);
    return ggml_reshape_3d(ctx, o, cDim, tokQ, nW);
  }

  // CrossAttention. x [Cq, M, Wq, Hq] in winQ windows, context [Ckv, N, Wk, Hk]
  // in winK windows; stride = winK / winQ (1 at stage 0, 0.5 and 2 at stage 1),
  // so both sides have the same window grid. Like torch, q, k, v are padded
  // with zeros after the projection, so padded key tokens still take attention
  // weight. torch pads the kv side with the query pad amounts, which only
  // agrees with a per-side pad when stride is 1; with the input padded to a
  // multiple of 16 the stride 0.5 and 2 blocks never pad (1/4 grid is a
  // multiple of 4, 1/8 grid of 2), and the check below guards that.
  T* crossAttention(
      ggml_context* ctx, T* x, T* context, const std::string& p, T* idx,
      int winQ, int winK) {
    const int64_t mDim = x->ne[1], wDim = x->ne[2], hDim = x->ne[3];
    const int64_t wPad = (wDim + winQ - 1) / winQ * winQ,
                  hPad = (hDim + winQ - 1) / winQ * winQ;
    const int64_t wDimK = context->ne[2], hDimK = context->ne[3];
    const int64_t wPadK = (wDimK + winK - 1) / winK * winK,
                  hPadK = (hDimK + winK - 1) / winK * winK;
    if (wPad / winQ != wPadK / winK || hPad / winQ != hPadK / winK) {
      throw std::runtime_error(
          "BridgeDepth: cross attention window grids differ in " + p);
    }
    T* q = linear(ctx, x, weight(p + "projq.weight"), weight(p + "projq.bias"));
    T* kv = linear(
        ctx, context, weight(p + "projkv.weight"), weight(p + "projkv.bias"));
    const int64_t cDim = q->ne[0];
    T* k = channelSlice(ctx, kv, 0, cDim);
    T* v = channelSlice(ctx, kv, cDim, cDim);
    T* qw = windowPartition(ctx, padTokens(ctx, q, wPad, hPad), winQ);
    T* kw = windowPartition(ctx, padTokens(ctx, k, wPadK, hPadK), winK);
    T* vw = windowPartition(ctx, padTokens(ctx, v, wPadK, hPadK), winK);
    T* o = rpeAttention(
        ctx,
        qw,
        kw,
        vw,
        weight(p + "relative_position_enc_table"),
        idx,
        nullptr);
    o = cropTokens(
        ctx, windowReverse(ctx, o, mDim, wPad, hPad, winQ), wDim, hDim);
    return linear(ctx, o, weight(p + "proj.weight"), weight(p + "proj.bias"));
  }

  // CrossBlock: x [C, M, W, H] query side, context [C, N, W, H]; the 31-wide
  // fourier pos goes on whichever side is the stereo embedding.
  T* crossBlock(
      ggml_context* ctx, T* x, T* context, T* xPos, T* ctxPos,
      const std::string& p, T* idx, int winQ, int winK) {
    T* xn = layerNorm(
        ctx, x, weight(p + "norm1.weight"), weight(p + "norm1.bias"), 1e-6f);
    if (xPos)
      xn = ggml_concat(ctx, xn, xPos, 0);
    T* cn = layerNorm(
        ctx,
        context,
        weight(p + "norm_y.weight"),
        weight(p + "norm_y.bias"),
        1e-6f);
    if (ctxPos)
      cn = ggml_concat(ctx, cn, ctxPos, 0);
    x = ggml_add(
        ctx, x, crossAttention(ctx, xn, cn, p + "attn.", idx, winQ, winK));
    T* h = layerNorm(
        ctx, x, weight(p + "norm2.weight"), weight(p + "norm2.bias"), 1e-6f);
    h = linear(
        ctx, h, weight(p + "mlp.fc1.weight"), weight(p + "mlp.fc1.bias"));
    h = ggml_gelu_erf(ctx, h);
    h = linear(
        ctx, h, weight(p + "mlp.fc2.weight"), weight(p + "mlp.fc2.bias"));
    return ggml_add(ctx, x, h);
  }

  // NMP.Attention: attention among the N proposals of one pixel, no MLP.
  // norm1 is a default nn.LayerNorm, eps 1e-5.
  T* selfNmp(ggml_context* ctx, T* x, T* pos, const std::string& p) {
    const int64_t cDim = x->ne[0], nDim = x->ne[1], wDim = x->ne[2],
                  hDim = x->ne[3], hwDim = wDim * hDim;
    const int64_t nHeads = inferHeads, dHead = cDim / nHeads;
    T* xn = layerNorm(
        ctx, x, weight(p + "norm1.weight"), weight(p + "norm1.bias"), 1e-5f);
    T* qk = ggml_concat(ctx, xn, pos, 0);
    T* q = linear(ctx, qk, weight(p + "q.weight"), weight(p + "q.bias"));
    T* k = linear(ctx, qk, weight(p + "k.weight"), weight(p + "k.bias"));
    T* v = linear(ctx, xn, weight(p + "v.weight"), weight(p + "v.bias"));
    auto heads = [&](T* t) { // [C, N, W, H] -> [Dh, N, Hh, HW]
      t = ggml_reshape_4d(ctx, t, dHead, nHeads, nDim, hwDim);
      return ggml_cont(ctx, ggml_permute(ctx, t, 0, 2, 1, 3));
    };
    T* kq = ggml_mul_mat(ctx, heads(k), heads(q)); // [Nk, Nq, Hh, HW]
    kq = ggml_soft_max_ext(
        ctx, kq, nullptr, 1.0f / std::sqrt(static_cast<float>(dHead)), 0.0f);
    T* vt = ggml_cont(ctx, ggml_transpose(ctx, heads(v))); // [N, Dh, Hh, HW]
    T* o = ggml_mul_mat(ctx, vt, kq);                      // [Dh, Nq, Hh, HW]
    o = ggml_cont(ctx, ggml_permute(ctx, o, 0, 2, 1, 3));  // [Dh, Hh, N, HW]
    o = ggml_reshape_4d(ctx, o, cDim, nDim, wDim, hDim);
    o = linear(ctx, o, weight(p + "proj.weight"), weight(p + "proj.bias"));
    return ggml_add(ctx, x, o);
  }

  // SwinNMP: shifted-window attention over (pixel, proposal) tokens with the
  // rpe terms, then the MLP. shift > 0 rolls by -shift before partitioning.
  T* swinNmp(
      ggml_context* ctx, T* x, T* pos, T* mask, int win, int shift,
      const std::string& p, T* idx) {
    const int64_t cDim = x->ne[0], nDim = x->ne[1], wDim = x->ne[2],
                  hDim = x->ne[3];
    const int64_t wPad = (wDim + win - 1) / win * win,
                  hPad = (hDim + win - 1) / win * win;
    T* xn = layerNorm(
        ctx, x, weight(p + "norm1.weight"), weight(p + "norm1.bias"), 1e-6f);
    xn = padTokens(ctx, ggml_concat(ctx, xn, pos, 0), wPad, hPad);
    if (shift > 0)
      xn = ggml_roll(ctx, xn, 0, 0, -shift, -shift);
    T* xw = windowPartition(ctx, xn, win); // [159, T, nW]
    T* qkv = linear(
        ctx,
        xw,
        weight(p + "attn.qkv.weight"),
        weight(p + "attn.qkv.bias")); // [3C, T, nW]
    T* o = rpeAttention(
        ctx,
        channelSlice(ctx, qkv, 0, cDim),
        channelSlice(ctx, qkv, cDim, cDim),
        channelSlice(ctx, qkv, 2 * cDim, cDim),
        weight(p + "attn.relative_position_enc_table"),
        idx,
        mask);
    o = linear(
        ctx, o, weight(p + "attn.proj.weight"), weight(p + "attn.proj.bias"));
    o = windowReverse(ctx, o, nDim, wPad, hPad, win);
    if (shift > 0)
      o = ggml_roll(ctx, o, 0, 0, shift, shift);
    x = ggml_add(ctx, x, cropTokens(ctx, o, wDim, hDim));
    T* h = layerNorm(
        ctx, x, weight(p + "norm2.weight"), weight(p + "norm2.bias"), 1e-6f);
    h = linear(
        ctx, h, weight(p + "mlp.fc1.weight"), weight(p + "mlp.fc1.bias"));
    h = ggml_gelu_erf(ctx, h);
    h = linear(
        ctx, h, weight(p + "mlp.fc2.weight"), weight(p + "mlp.fc2.bias"));
    return ggml_add(ctx, x, h);
  }

  // NMRF.sample_fmap: x-only bilinear sample of fmap at w - d with zeros
  // outside [0, W-1]; the grid normalise and un-normalise cancel. fmap is the
  // image layout [W, H, C, 1], disp [1, N, W, H]. Returns [C, N, W, H].
  T* sampleFmap(ggml_context* ctx, T* fmap, T* disp, const AlignInputs& in) {
    const int64_t wDim = fmap->ne[0], hDim = fmap->ne[1], cDim = fmap->ne[2],
                  nDim = disp->ne[1];
    T* rows =
        ggml_reshape_2d(ctx, toChannelsFirst(ctx, fmap), cDim, wDim * hDim);
    T* x =
        ggml_sub(ctx, ggml_repeat_4d(ctx, in.wIdx, 1, nDim, wDim, hDim), disp);
    T* i0 = ggml_floor(ctx, x);
    T* t = ggml_sub(ctx, x, i0);
    T* i1 = ggml_scale_bias(ctx, i0, 1.0f, 1.0f);
    auto inside = [&](T* i) { // 1 where 0 <= i <= W-1, i integer-valued
      return ggml_mul(
          ctx,
          ggml_step(ctx, ggml_scale_bias(ctx, i, 1.0f, 0.5f)),
          ggml_step(
              ctx,
              ggml_scale_bias(ctx, i, -1.0f, static_cast<float>(wDim) - 0.5f)));
    };
    T* w0 = ggml_mul(ctx, ggml_scale_bias(ctx, t, -1.0f, 1.0f), inside(i0));
    T* w1 = ggml_mul(ctx, t, inside(i1));
    auto gather = [&](T* i) {
      // ggml_clamp works in place (its result is a view of the input), so clamp
      // a copy or the masks and t above read the clamped index.
      T* r = ggml_add(
          ctx,
          ggml_clamp(
              ctx, ggml_cont(ctx, i), 0.0f, static_cast<float>(wDim - 1)),
          in.rowBase);
      T* f = ggml_get_rows(
          ctx,
          rows,
          ggml_cast(
              ctx, ggml_reshape_1d(ctx, r, nDim * wDim * hDim), GGML_TYPE_I32));
      return ggml_reshape_4d(ctx, f, cDim, nDim, wDim, hDim);
    };
    return ggml_add(
        ctx, ggml_mul(ctx, gather(i0), w0), ggml_mul(ctx, gather(i1), w1));
  }

  // NMRF.construct_hypothesis_embedding. cc1, cc2 [W, H, 64, 1], gw1, gw2
  // [W, H, 256, 1], disp [1, N, W, H]. Returns the embedding [128, N, W, H] and
  // the fourier pos [31, N, W, H].
  std::pair<T*, T*> hypothesisEmbedding(
      ggml_context* ctx, T* cc1, T* cc2, T* gw1, T* gw2, T* disp,
      float normalizer, const AlignInputs& in) {
    const int64_t wDim = cc1->ne[0], hDim = cc1->ne[1], nDim = disp->ne[1];
    T* warpedGw = sampleFmap(ctx, gw2, disp, in); // [256, N, W, H]
    T* gw1c = ggml_reshape_4d(
        ctx, toChannelsFirst(ctx, gw1), gw1->ne[2], 1, wDim, hDim);
    T* prod = ggml_mul(ctx, warpedGw, gw1c);
    T* corr = ggml_mul_mat(
        ctx,
        in.avg32,
        ggml_reshape_2d(
            ctx, prod, prod->ne[0], nDim * wDim * hDim)); // [32, N*W*H]
    corr = ggml_reshape_4d(ctx, corr, corr->ne[0], nDim, wDim, hDim);
    T* warped = sampleFmap(ctx, cc2, disp, in); // [64, N, W, H]
    T* f1 = ggml_repeat_4d(
        ctx,
        ggml_reshape_4d(
            ctx, toChannelsFirst(ctx, cc1), cc1->ne[2], 1, wDim, hDim),
        cc1->ne[2],
        nDim,
        wDim,
        hDim);
    T* feat = ggml_concat(
        ctx, ggml_concat(ctx, f1, warped, 0), corr, 0); // [160, N, W, H]
    T* e = linear(
        ctx,
        feat,
        weight("stereo.ffn.fc1.weight"),
        weight("stereo.ffn.fc1.bias"));
    e = ggml_gelu_erf(ctx, e);
    e = linear(
        ctx, e, weight("stereo.ffn.fc2.weight"), weight("stereo.ffn.fc2.bias"));
    T* pos = fourierEmbed(ctx, disp, in.freqs, 3.14f / normalizer);
    return {e, pos};
  }

  // Alignment stage 0 (align_0) plus the heads. stereo [128, N, W, H], mono
  // [128, 1, W, H], pos [31, N, W, H], disp [1, N, W, H] the proposals.
  Outputs buildAlign0(
      ggml_context* ctx, T* stereo, T* mono, T* pos, T* disp,
      const AlignInputs& in) {
    Outputs outs;
    const int64_t nDim = stereo->ne[1], wDim = stereo->ne[2],
                  hDim = stereo->ne[3];
    for (int l = 0; l < numInferLayers; ++l) {
      const std::string p = "align_0.layers." + std::to_string(l) + ".";
      const bool odd = l % 2 == 1;
      stereo = crossBlock(
          ctx,
          stereo,
          mono,
          pos,
          nullptr,
          p + "readout.",
          in.idxReadout[l],
          windowSize,
          windowSize);
      stereo = selfNmp(ctx, stereo, pos, p + "attn.self_nmp.");
      stereo = swinNmp(
          ctx,
          stereo,
          pos,
          odd ? in.maskOdd : in.maskEven,
          windowSize,
          odd ? windowSize / 2 : 0,
          p + "attn.nmp.",
          in.idxNmp[l]);
      mono = crossBlock(
          ctx,
          mono,
          stereo,
          nullptr,
          pos,
          p + "update.",
          in.idxUpdate[l],
          windowSize,
          windowSize);
    }
    stereo = layerNorm(
        ctx,
        stereo,
        weight("align_0.norm.weight"),
        weight("align_0.norm.bias"),
        1e-6f);
    outs.emplace_back("align0.stereo", stereo);
    outs.emplace_back(
        "align0.mono", ggml_reshape_3d(ctx, mono, mono->ne[0], wDim, hDim));

    T* update = head3(ctx, stereo, "infer_head."); // [64, N, W, H]
    outs.emplace_back("infer_head.out", update);
    T* logit = ggml_scale(
        ctx,
        linear(
            ctx,
            stereo,
            weight("infer_score_head.weight"),
            weight("infer_score_head.bias")),
        0.25f);
    T* disp0 = ggml_relu(ctx, ggml_add(ctx, update, disp)); // [64, N, W, H]
    // torch.max over N picks index 0 on ties and step(0) = 0, so the blend
    // matches.
    auto nSlice = [&](T* t, int n) {
      return ggml_cont(
          ctx,
          ggml_view_4d(
              ctx,
              t,
              t->ne[0],
              1,
              wDim,
              hDim,
              t->nb[1],
              t->nb[2],
              t->nb[3],
              n * t->nb[1]));
    };
    if (nDim != 2)
      throw std::runtime_error(
          "BridgeDepth: disp_est selection expects 2 proposals");
    T* sel = ggml_step(ctx, ggml_sub(ctx, nSlice(logit, 1), nSlice(logit, 0)));
    T* d0 = nSlice(disp0, 0);
    T* dsel = ggml_add(
        ctx,
        d0,
        ggml_mul(
            ctx, sel, ggml_sub(ctx, nSlice(disp0, 1), d0))); // [64, 1, W, H]
    dsel = ggml_scale(ctx, dsel, 2.0f);
    // The 8x8 block (ws fastest) splits into 2x2 quadrants of 4x4; each
    // quadrant is one 1/4-res pixel whose 16 values are sorted and the 8th
    // taken. 64 = (ws_lo 4, ws_hi 2, hs_lo 4, hs_hi 2) -> [16 = (ws_lo, hs_lo),
    // X4 = (ws_hi, w), Y4 = (hs_hi, h)]
    T* g = ggml_reshape_4d(
        ctx,
        dsel,
        4,
        2,
        4,
        2 * wDim * hDim); // [ws_lo, ws_hi, hs_lo, (hs_hi, w, h)]
    g = ggml_cont(
        ctx,
        ggml_permute(
            ctx, g, 0, 2, 1, 3)); // [ws_lo, hs_lo, ws_hi, (hs_hi, w, h)]
    g = ggml_reshape_4d(
        ctx, g, 16 * 2, 2, wDim, hDim); // [(g, ws_hi), hs_hi, w, h]
    g = ggml_cont(
        ctx, ggml_permute(ctx, g, 0, 2, 1, 3)); // [(g, ws_hi), w, hs_hi, h]
    const int64_t xyDim = 4 * wDim * hDim;
    g = ggml_reshape_2d(ctx, g, 16, xyDim);
    T* order = ggml_argsort(ctx, g, GGML_SORT_ORDER_ASC); // I32 [16, XY]
    T* col7 = ggml_cont(
        ctx,
        ggml_view_2d(ctx, order, 1, xyDim, order->nb[1], 7 * sizeof(int32_t)));
    T* est = ggml_get_rows(
        ctx, ggml_reshape_3d(ctx, g, 1, 16, xyDim), col7); // [1, 1, XY]
    outs.emplace_back(
        "disp_est", ggml_reshape_2d(ctx, est, 2 * wDim, 2 * hDim));
    return outs;
  }

  // Alignment stage 1 (align_1, refine=True) plus refine_head. stereo
  // [128, 1, W4, H4] at 1/4, mono [128, 1, W8, H8] at 1/8 from stage 0, pos
  // [31, 1, W4, H4], dispEst [1, 1, W4, H4] in 1/4-res pixels. readout is the
  // stride 0.5 CrossBlock (query 4x4 windows, kv 2x2), the layer attention is
  // SwinNMP only (RefinementLayer, no self_nmp since N = 1), update is the
  // stride 2 CrossBlock (query 2x2, kv 4x4). Returns disp_final_padded [W, H].
  Outputs buildAlign1(
      ggml_context* ctx, T* stereo, T* mono, T* pos, T* dispEst,
      const AlignInputs& in) {
    Outputs outs;
    const int64_t wDim = stereo->ne[2], hDim = stereo->ne[3];
    const int win = refineWindowSize, winK = win / 2;
    for (int l = 0; l < numRefineLayers; ++l) {
      const std::string p = "align_1.layers." + std::to_string(l) + ".";
      const bool odd = l % 2 == 1;
      stereo = crossBlock(
          ctx,
          stereo,
          mono,
          pos,
          nullptr,
          p + "readout.",
          in.idxReadout[l],
          win,
          winK);
      stereo = swinNmp(
          ctx,
          stereo,
          pos,
          odd ? in.maskOdd : nullptr,
          win,
          odd ? win / 2 : 0,
          p + "attn.nmp.",
          in.idxNmp[l]);
      mono = crossBlock(
          ctx,
          mono,
          stereo,
          nullptr,
          pos,
          p + "update.",
          in.idxUpdate[l],
          winK,
          win);
    }
    stereo = layerNorm(
        ctx,
        stereo,
        weight("align_1.norm.weight"),
        weight("align_1.norm.bias"),
        1e-6f);
    outs.emplace_back("align1.stereo", stereo);
    outs.emplace_back(
        "align1.mono",
        ggml_reshape_3d(ctx, mono, mono->ne[0], mono->ne[2], mono->ne[3]));
    T* update = head3(ctx, stereo, "refine_head."); // [16, 1, W4, H4]
    outs.emplace_back(
        "refine_head.out",
        ggml_reshape_3d(ctx, update, update->ne[0], wDim, hDim));
    T* d1 = ggml_relu(
        ctx, ggml_add(ctx, update, dispEst)); // [16 = (ws, hs), 1, W4, H4]
    // '(hs ws)' with ws fastest -> full resolution [(ws, w), (hs, h)], times 4.
    T* g = ggml_reshape_4d(ctx, d1, win, win, wDim, hDim); // [ws, hs, w, h]
    g = ggml_cont(ctx, ggml_permute(ctx, g, 0, 2, 1, 3));  // [ws, w, hs, h]
    outs.emplace_back(
        "disp_final_padded",
        ggml_scale(ctx, ggml_reshape_2d(ctx, g, win * wDim, win * hDim), 4.0f));
    return outs;
  }
};

namespace {

// FNV-1a over every tensor's name, type and shape in file order plus the
// hyperparameters the graph reads. The graph hard-codes the rvc_pretrain ViT-S
// layout and ggml aborts (it does not throw) on a shape mismatch, so a GGUF is
// accepted only when this matches the converter's output exactly. It catches
// wrong converter output, not a crafted file: FNV-1a can be forced to collide.
// So the hyperparameters, the pos_embed shape and the tensor data that indexes
// memory are checked separately at load.
uint64_t layoutFingerprint(
    const gguf_context* gctx, const ggml_context* wctx,
    const std::vector<uint32_t>& kv) {
  uint64_t h = 1469598103934665603ULL;
  auto mix = [&h](const void* data, size_t n) {
    const auto* bytes = static_cast<const unsigned char*>(data);
    for (size_t i = 0; i < n; ++i) {
      h ^= bytes[i];
      h *= 1099511628211ULL;
    }
  };
  for (const uint32_t v : kv)
    mix(&v, sizeof(v));
  for (int64_t i = 0; i < gguf_get_n_tensors(gctx); ++i) {
    const char* name = gguf_get_tensor_name(gctx, i);
    mix(name, std::char_traits<char>::length(name) + 1);
    const T* t = ggml_get_tensor(const_cast<ggml_context*>(wctx), name);
    const auto type = static_cast<int32_t>(t->type);
    mix(&type, sizeof(type));
    mix(t->ne, sizeof(t->ne));
  }
  return h;
}

// scripts/convert-bridgedepth.py output for rvc_pretrain + vits. Update this
// together with the converter when the tensor layout changes.
constexpr uint64_t EXPECTED_LAYOUT = 12314121931801583502ULL;

} // namespace

BridgeDepthGraph::BridgeDepthGraph(
    const std::string& ggufPath, ggml_backend_t device, ggml_backend_t cpu,
    Mode mode)
    : impl_(std::make_unique<Impl>()) {
  Impl& m = *impl_;
  m.backend = device;
  m.cpu = cpu;
  m.measureOnly = mode == Mode::Measure;
  std::ifstream f(ggufPath, std::ios::binary | std::ios::ate);
  if (!f)
    throw std::runtime_error("BridgeDepth: cannot open " + ggufPath);
  const auto fileSize = static_cast<uint64_t>(f.tellg());
  gguf_init_params gp{};
  gp.no_alloc = true;
  gp.ctx = &m.wctx;
  m.gctx = gguf_init_from_file(ggufPath.c_str(), gp);
  if (!m.gctx || !m.wctx)
    throw std::runtime_error("BridgeDepth: invalid GGUF " + ggufPath);

  const int64_t archId = gguf_find_key(m.gctx, "general.architecture");
  if (archId < 0 || gguf_get_kv_type(m.gctx, archId) != GGUF_TYPE_STRING ||
      std::string(gguf_get_val_str(m.gctx, archId)) != "bridgedepth") {
    throw std::runtime_error("BridgeDepth: expected bridgedepth architecture");
  }
  m.monoDepth = static_cast<int>(m.kvU32("bridgedepth.mono.depth"));
  m.monoHeads = static_cast<int>(m.kvU32("bridgedepth.mono.n_heads"));
  m.posGrid = static_cast<int>(m.kvU32("bridgedepth.mono.pos_grid"));
  m.monoLayers = m.kvI32Array("bridgedepth.mono.intermediate_layers");
  m.numDisp = static_cast<int>(m.kvU32("bridgedepth.dpn.num_disp"));
  m.costGroup = static_cast<int>(m.kvU32("bridgedepth.dpn.cost_group"));
  m.numProposals = static_cast<int>(m.kvU32("bridgedepth.dpn.num_proposals"));
  m.propHeads = static_cast<int>(m.kvU32("bridgedepth.nmp.prop_n_heads"));
  m.numPropLayers =
      static_cast<int>(m.kvU32("bridgedepth.nmp.num_prop_layers"));
  m.inferHeads = static_cast<int>(m.kvU32("bridgedepth.nmp.infer_n_heads"));
  m.windowSize = static_cast<int>(m.kvU32("bridgedepth.nmp.window_size"));
  m.numInferLayers =
      static_cast<int>(m.kvU32("bridgedepth.nmp.num_infer_layers"));
  m.refineWindowSize =
      static_cast<int>(m.kvU32("bridgedepth.nmp.refine_window_size"));
  m.numRefineLayers =
      static_cast<int>(m.kvU32("bridgedepth.nmp.num_refine_layers"));
  const uint32_t outChannels = m.kvU32("bridgedepth.backbone.out_channels");
  std::vector<uint32_t> kv{
      static_cast<uint32_t>(m.monoDepth),
      static_cast<uint32_t>(m.monoHeads),
      static_cast<uint32_t>(m.posGrid),
      static_cast<uint32_t>(m.numDisp),
      static_cast<uint32_t>(m.costGroup),
      static_cast<uint32_t>(m.numProposals),
      static_cast<uint32_t>(m.propHeads),
      static_cast<uint32_t>(m.numPropLayers),
      static_cast<uint32_t>(m.inferHeads),
      static_cast<uint32_t>(m.windowSize),
      static_cast<uint32_t>(m.numInferLayers),
      static_cast<uint32_t>(m.refineWindowSize),
      static_cast<uint32_t>(m.numRefineLayers),
      outChannels};
  for (const int l : m.monoLayers)
    kv.push_back(static_cast<uint32_t>(l));
  // The host code divides by and indexes with these values, so they are pinned
  // to the converter output directly. The fingerprint alone can be forged.
  const std::vector<uint32_t> expectedKv{
      12, 6, 37, 40, 4, 2, 4, 5, 4, 6, 5, 4, 5, 128, 2, 5, 8, 11};
  if (kv != expectedKv) {
    throw std::runtime_error(
        "BridgeDepth: unsupported hyperparameters; convert with "
        "scripts/convert-bridgedepth.py");
  }
  const uint64_t layout = layoutFingerprint(m.gctx, m.wctx, kv);
  if (layout != EXPECTED_LAYOUT) {
    throw std::runtime_error(
        "BridgeDepth: unsupported GGUF layout " + std::to_string(layout) +
        "; convert with scripts/convert-bridgedepth.py");
  }

  const uint64_t dataOff = gguf_get_data_offset(m.gctx);
  for (int64_t i = 0; i < gguf_get_n_tensors(m.gctx); ++i) {
    const T* t = ggml_get_tensor(m.wctx, gguf_get_tensor_name(m.gctx, i));
    const uint64_t off = gguf_get_tensor_offset(m.gctx, i);
    if (dataOff > fileSize || off > fileSize - dataOff ||
        ggml_nbytes(t) > fileSize - dataOff - off) {
      throw std::runtime_error(
          std::string("BridgeDepth: truncated tensor ") +
          gguf_get_tensor_name(m.gctx, i));
    }
    m.readBufferBytes = std::max<uint64_t>(m.readBufferBytes, ggml_nbytes(t));
  }

  if (m.measureOnly) {
    m.measured.weightBytes = ctxBufferBytes(m.wctx, m.backend);
    m.emptyWeights = placeOnEmptyWeightBuffers(m.wctx, m.backend);
  } else {
    m.wbuf = ggml_backend_alloc_ctx_tensors(m.wctx, m.backend);
    if (!m.wbuf)
      throw ResourceError("BridgeDepth: weight allocation failed");
    ggml_backend_buffer_set_usage(m.wbuf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
    std::vector<char> buf;
    for (int64_t i = 0; i < gguf_get_n_tensors(m.gctx); ++i) {
      T* t = ggml_get_tensor(m.wctx, gguf_get_tensor_name(m.gctx, i));
      buf.resize(ggml_nbytes(t));
      f.seekg(
          static_cast<std::streamoff>(
              dataOff + gguf_get_tensor_offset(m.gctx, i)));
      f.read(buf.data(), static_cast<std::streamsize>(buf.size()));
      if (!f)
        throw std::runtime_error("BridgeDepth: short read on tensor data");
      ggml_backend_tensor_set(t, buf.data(), 0, buf.size());
    }
  }
  T* pos = m.weight("mono.pretrained.pos_embed");
  // posEmbed() indexes this as [1 + pos_grid^2, D] on the host.
  if (pos->type != GGML_TYPE_F32 || pos->ne[1] != 1 + m.posGrid * m.posGrid)
    throw std::runtime_error("BridgeDepth: pos_embed does not match pos_grid");
  m.posDim = pos->ne[0];
  m.posRows = pos->ne[1];
  // Measure mode reads no tensor data, so it keeps none of the host copies
  // below; the graph takes only their shapes.
  if (!m.measureOnly) {
    m.posEmbedHost.resize(ggml_nelements(pos));
    ggml_backend_tensor_get(pos, m.posEmbedHost.data(), 0, ggml_nbytes(pos));
  }
  // relative_position_index buffers are expanded on the host per run (M, N
  // tokens per pixel depend on the stage), so keep them host-side.
  for (int64_t i = 0; i < gguf_get_n_tensors(m.gctx); ++i) {
    const std::string name = gguf_get_tensor_name(m.gctx, i);
    if (name.size() < 24 ||
        name.compare(name.size() - 24, 24, ".relative_position_index") != 0)
      continue;
    T* t = ggml_get_tensor(m.wctx, name.c_str());
    if (t->type != GGML_TYPE_I32)
      throw std::runtime_error("BridgeDepth: " + name + " is not I32");
    m.rpeIndexElems.emplace(name, ggml_nelements(t));
    if (m.measureOnly)
      continue;
    std::vector<int32_t> idx(ggml_nelements(t));
    ggml_backend_tensor_get(t, idx.data(), 0, ggml_nbytes(t));
    // The values become get_rows indices into the table. The layout
    // fingerprint does not cover tensor data, and GPU get_rows does not bound
    // check, so an out-of-range value would read past the table.
    const std::string table =
        name.substr(0, name.size() - 24) + ".relative_position_enc_table";
    const int64_t rows = m.weight(table)->ne[1];
    for (const int32_t v : idx) {
      if (v < 0 || v >= rows)
        throw std::runtime_error(
            "BridgeDepth: " + name + " has an index outside " + table);
    }
    m.rpeIndexHost.emplace(name, std::move(idx));
  }

  std::vector<ggml_backend_t> backends{m.backend};
  if (m.backend != m.cpu)
    backends.push_back(m.cpu);
  m.sched = ggml_backend_sched_new(
      backends.data(),
      nullptr,
      static_cast<int>(backends.size()),
      GRAPH_SIZE,
      false,
      true);
  if (!m.sched)
    throw ResourceError("BridgeDepth: scheduler creation failed");
}

BridgeDepthGraph::~BridgeDepthGraph() = default;

size_t BridgeDepthGraph::weightBytes() const {
  return ggml_backend_buffer_get_size(impl_->wbuf);
}

BufferFootprint BridgeDepthGraph::allocatedBuffers() const {
  const Impl& m = *impl_;
  BufferFootprint result = m.allocated;
  result.weightBytes = allocatedCtxBytes(m.wctx);
  return result;
}

int BridgeDepthGraph::cpuFallbackNodes() const { return impl_->fallbackNodes; }

namespace {
std::vector<float> channelConst(const float (&v)[3]) {
  return std::vector<float>(v, v + 3);
}
} // namespace

namespace {

// -inf between the N tokens of the same pixel, 0 elsewhere, 0 on the diagonal
// (WindowAttention.gen_window_attn_mask). Token order is (pixel, n), n fastest.
std::vector<float> selfEdgeMask(int64_t pixels, int64_t n) {
  const int64_t t = pixels * n;
  std::vector<float> m(t * t, 0.0f);
  for (int64_t i = 0; i < t; ++i) {
    for (int64_t j = 0; j < t; ++j) {
      if (i != j && i / n == j / n)
        m[i * t + j] = -INFINITY;
    }
  }
  return m;
}

// WindowAttention.gen_shift_window_attn_mask: -inf between tokens whose pixels
// fall in different shifted regions, plus the self-edge mask. Layout
// [Tk, Tq, 1, nW], windows (i, j) with j fastest, tokens (hs, ws, n) n fastest.
std::vector<float>
shiftWindowMask(int hPad, int wPad, int win, int shift, int n) {
  auto regionOf = [&](int v, int size) {
    if (v < size - win)
      return 0;
    if (v < size - shift)
      return 1;
    return 2;
  };
  const int tokens = win * win * n, nWx = wPad / win, nWy = hPad / win;
  std::vector<float> m(static_cast<size_t>(tokens) * tokens * nWx * nWy, 0.0f);
  auto region = [&](int wi, int wj, int tok) {
    const int p = tok / n, hs = p / win, ws = p % win;
    return regionOf(wi * win + hs, hPad) * 3 + regionOf(wj * win + ws, wPad);
  };
  for (int wi = 0; wi < nWy; ++wi) {
    for (int wj = 0; wj < nWx; ++wj) {
      float* base =
          m.data() + static_cast<size_t>(wi * nWx + wj) * tokens * tokens;
      for (int tq = 0; tq < tokens; ++tq) {
        for (int tk = 0; tk < tokens; ++tk) {
          const bool sameRegion = region(wi, wj, tq) == region(wi, wj, tk);
          const bool selfEdge = tq != tk && tq / n == tk / n;
          if (!sameRegion || selfEdge)
            base[tq * tokens + tk] = -INFINITY;
        }
      }
    }
  }
  return m;
}

// Expands a [Pq, Pk] relative_position_index (Pq query and Pk key pixels per
// window, row i, column j) over the M query and N key tokens of each pixel:
// token i' = i*M + m, j' = j*N + n. Layout [Tk*Tq] with j' fastest, the
// get_rows row order.
std::vector<int32_t> expandRpeIndex(
    const std::vector<int32_t>& base, int pixQ, int pixK, int mDim, int nDim) {
  if (static_cast<int>(base.size()) != pixQ * pixK)
    throw std::runtime_error("BridgeDepth: unexpected rpe index size");
  const int tokQ = pixQ * mDim, tokK = pixK * nDim;
  std::vector<int32_t> out(static_cast<size_t>(tokQ) * tokK);
  for (int i = 0; i < tokQ; ++i) {
    for (int j = 0; j < tokK; ++j)
      out[static_cast<size_t>(i) * tokK + j] =
          base[(i / mDim) * pixK + j / nDim];
  }
  return out;
}

// Per-run host inputs of one alignment stage: pixel index, row base for the
// get_rows gather, the two masks and the expanded rpe indices per layer. The
// shapes are always set; the vectors stay empty in measure mode.
struct AlignHost {
  std::vector<float> wIdx, rowBase, maskEven, maskOdd;
  std::vector<std::vector<int32_t>> idxReadout, idxNmp, idxUpdate;
  int wPad = 0, hPad = 0, T = 0;
  bool hasMaskEven = false;
  int64_t readoutElems = 0, nmpElems = 0, updateElems = 0;
};

} // namespace

std::vector<float> BridgeDepthGraph::infer(
    const float* left, const float* right, int h, int w,
    const std::vector<float>* seedsOverride) {
  if (impl_->measureOnly)
    throw std::runtime_error("BridgeDepth: graph was opened to measure only");
  return impl_->forward(left, right, h, w, seedsOverride);
}

MeasuredBuffers BridgeDepthGraph::measure(int h, int w) {
  Impl& m = *impl_;
  if (!m.measureOnly)
    throw std::runtime_error("BridgeDepth: graph was not opened to measure");
  m.forward(nullptr, nullptr, h, w, nullptr);
  MeasuredBuffers result;
  result.buffers = m.measured;
  // The host copies inference keeps of pos_embed and the rpe indices.
  uint64_t persistentBytes =
      static_cast<uint64_t>(m.posDim) * m.posRows * sizeof(float);
  for (const auto& [name, elements] : m.rpeIndexElems)
    persistentBytes += static_cast<uint64_t>(elements) * sizeof(int32_t);
  // BridgeDepthModel::process holds both views as planar floats during the
  // run, and forward() returns the unpadded disparity.
  const uint64_t pixels = static_cast<uint64_t>(h) * w;
  const uint64_t planarViewFloats = 2ULL * 3 * pixels;
  const uint64_t inferenceBytes =
      m.measuredRunHostBytes + (planarViewFloats + pixels) * sizeof(float);
  result.hostStagingBytes =
      persistentBytes + std::max(m.readBufferBytes, inferenceBytes);
  return result;
}

std::vector<float> BridgeDepthGraph::Impl::forward(
    const float* left, const float* right, int h, int w,
    const std::vector<float>* seedsOverride) {
  Impl& m = *this;
  if (h < MIN_SIDE || w < MIN_SIDE)
    throw std::runtime_error(
        "BridgeDepth: image is smaller than the minimum size");
  const Padding pad = computePadding(h, w, PAD_DIVISOR);
  const int hDim = h + pad.top, wDim = w + pad.right;
  const size_t plane = static_cast<size_t>(3) * hDim * wDim;
  // Host data of one graph input, built only when the run computes. Measure
  // mode gets an empty value and the input takes only its shape.
  auto hostOnly = [&](const auto& build) -> decltype(build()) {
    if (m.measureOnly)
      return {};
    return build();
  };
  const std::vector<float> imgs = hostOnly([&] {
    std::vector<float> both(2 * plane);
    padImageInto(left, h, w, pad, both.data());
    padImageInto(right, h, w, pad, both.data() + plane);
    return both;
  });
  const int ph = hDim / 8 * 7 / 14, pw = wDim / 8 * 7 / 14;
  const std::vector<float> noFloats;
  const std::vector<float>& pos = m.measureOnly ? noFloats : m.posEmbed(ph, pw);
  const std::vector<float> mean =
      hostOnly([] { return channelConst(MEAN_RGB); });
  const std::vector<float> stdv =
      hostOnly([] { return channelConst(STD_RGB); });
  const int h8 = hDim / 8, w8 = wDim / 8, nDim = m.numProposals;
  if (seedsOverride &&
      seedsOverride->size() != static_cast<size_t>(nDim) * h8 * w8) {
    throw std::runtime_error(
        "BridgeDepth: seedsOverride must be [H/8 * W/8, N] after padding");
  }
  const int cDim = m.kvU32("bridgedepth.backbone.out_channels");
  const int per = cDim / m.costGroup;
  const std::vector<float> avg = hostOnly([&] {
    std::vector<float> out(static_cast<size_t>(cDim) * m.costGroup, 0.0f);
    for (int g = 0; g < m.costGroup; ++g) {
      for (int c = 0; c < per; ++c)
        out[static_cast<size_t>(g) * cDim + static_cast<size_t>(g) * per + c] =
            1.0f / per;
    }
    return out;
  });
  const std::vector<float> arange = hostOnly([&] {
    std::vector<float> out(m.numDisp);
    for (int i = 0; i < m.numDisp; ++i)
      out[i] = static_cast<float>(i);
    return out;
  });
  const std::vector<float> offsets = hostOnly([] {
    std::vector<float> out(9);
    for (int i = 0; i < 9; ++i)
      out[i] = static_cast<float>(i - 4);
    return out;
  });
  const std::vector<float> freqs = hostOnly([] {
    std::vector<float> out(15);
    for (int i = 0; i < 15; ++i)
      out[i] = std::ldexp(1.0f, i);
    return out;
  });
  const std::vector<float> maskCol =
      hostOnly([&] { return selfEdgeMask(h8, nDim); });
  const std::vector<float> maskRow =
      hostOnly([&] { return selfEdgeMask(w8, nDim); });

  // alignment host inputs, stage 0 at 1/8 with N proposals, stage 1 at 1/4 with
  // one
  auto rpeIndex = [&](const std::string& name,
                      int pixQ,
                      int pixK,
                      int queryTokens,
                      int keyTokens) -> std::vector<int32_t> {
    auto elems = m.rpeIndexElems.find(name);
    if (elems == m.rpeIndexElems.end())
      throw std::runtime_error("BridgeDepth: missing " + name);
    if (elems->second != static_cast<int64_t>(pixQ) * pixK)
      throw std::runtime_error("BridgeDepth: unexpected rpe index size");
    return hostOnly([&] {
      return expandRpeIndex(
          m.rpeIndexHost.at(name), pixQ, pixK, queryTokens, keyTokens);
    });
  };
  auto alignHost = [&](int wGrid,
                       int hGrid,
                       int win,
                       int n,
                       const std::string& prefix,
                       int layers,
                       bool refine) {
    AlignHost a;
    const int pix = win * win, pixK = refine ? (win / 2) * (win / 2) : pix;
    a.wPad = (wGrid + win - 1) / win * win;
    a.hPad = (hGrid + win - 1) / win * win;
    a.T = pix * n;
    a.hasMaskEven = n > 1;
    // Token counts of the expanded indices, see expandRpeIndex.
    a.readoutElems = static_cast<int64_t>(pix) * n * pixK;
    a.nmpElems = static_cast<int64_t>(pix) * n * pix * n;
    a.updateElems = static_cast<int64_t>(pixK) * pix * n;
    a.wIdx = hostOnly([&] {
      std::vector<float> out(wGrid);
      for (int x = 0; x < wGrid; ++x)
        out[x] = static_cast<float>(x);
      return out;
    });
    a.rowBase = hostOnly([&] {
      std::vector<float> out(static_cast<size_t>(wGrid) * hGrid);
      for (int y = 0; y < hGrid; ++y) {
        for (int x = 0; x < wGrid; ++x)
          out[static_cast<size_t>(y) * wGrid + x] =
              static_cast<float>(y) * wGrid;
      }
      return out;
    });
    if (a.hasMaskEven)
      a.maskEven = hostOnly([&] { return selfEdgeMask(pix, n); });
    a.maskOdd = hostOnly(
        [&] { return shiftWindowMask(a.hPad, a.wPad, win, win / 2, n); });
    for (int l = 0; l < layers; ++l) {
      const std::string p = prefix + std::to_string(l) + ".";
      a.idxReadout.push_back(rpeIndex(
          p + "readout.attn.relative_position_index", pix, pixK, n, 1));
      a.idxNmp.push_back(rpeIndex(
          p + "attn.nmp.attn.relative_position_index", pix, pix, n, n));
      a.idxUpdate.push_back(
          rpeIndex(p + "update.attn.relative_position_index", pixK, pix, 1, n));
    }
    return a;
  };
  const int h4 = hDim / 4, w4 = wDim / 4;
  const AlignHost a0 = alignHost(
      w8, h8, m.windowSize, nDim, "align_0.layers.", m.numInferLayers, false);
  const AlignHost a1 = alignHost(
      w4,
      h4,
      m.refineWindowSize,
      1,
      "align_1.layers.",
      m.numRefineLayers,
      true);
  const int cGw = static_cast<int>(m.weight("stereo.gw.3.weight")->ne[3]),
            gCorr = 32, perG = cGw / gCorr;
  const std::vector<float> avg32 = hostOnly([&] {
    std::vector<float> out(static_cast<size_t>(cGw) * gCorr, 0.0f);
    for (int g = 0; g < gCorr; ++g) {
      for (int c = 0; c < perG; ++c)
        out[static_cast<size_t>(g) * cGw + g * perG + c] = 1.0f / perG;
    }
    return out;
  });

  std::map<std::string, HostTensor> outsHost = m.run([&](ggml_context* ctx,
                                                         Impl::Inputs& in) {
    T* ti = in.add(ctx, "imgs", imgs, wDim, hDim, 3, 2);
    T* tm = in.add(ctx, "mean", mean, 1, 1, 3, 1);
    T* ts = in.add(ctx, "std", stdv, 1, 1, 3, 1);
    T* tp = in.add(ctx, "pos", pos, m.posDim, 1 + ph * pw);
    Impl::DpnInputs di;
    di.avg = in.add(ctx, "avg", avg, cDim, m.costGroup);
    di.arange = in.add(ctx, "arange", arange, 1, m.numDisp);
    di.offsets = in.add(ctx, "offsets", offsets, 9);
    di.freqs = in.add(ctx, "freqs", freqs, 15);
    const int64_t colSide = static_cast<int64_t>(h8) * nDim;
    const int64_t rowSide = static_cast<int64_t>(w8) * nDim;
    di.maskCol = in.add(ctx, "mask_col", maskCol, colSide, colSide);
    di.maskRow = in.add(ctx, "mask_row", maskRow, rowSide, rowSide);
    if (seedsOverride)
      di.seedsOverride = in.add(
          ctx,
          "seeds_override",
          *seedsOverride,
          nDim,
          static_cast<int64_t>(h8) * w8);
    T* avg32T = in.add(ctx, "avg32", avg32, cGw, gCorr);
    auto alignInputs = [&](const AlignHost& a,
                           int wGrid,
                           int hGrid,
                           int win,
                           const std::string& s) {
      Impl::AlignInputs ai;
      ai.wIdx = in.add(ctx, ("w_idx" + s).c_str(), a.wIdx, 1, 1, wGrid, 1);
      ai.rowBase =
          in.add(ctx, ("row_base" + s).c_str(), a.rowBase, 1, 1, wGrid, hGrid);
      ai.avg32 = avg32T;
      ai.freqs = di.freqs;
      ai.maskEven =
          a.hasMaskEven
              ? in.add(ctx, ("mask_even" + s).c_str(), a.maskEven, a.T, a.T)
              : nullptr;
      ai.maskOdd = in.add(
          ctx,
          ("mask_odd" + s).c_str(),
          a.maskOdd,
          a.T,
          a.T,
          1,
          static_cast<int64_t>(a.wPad / win) * (a.hPad / win));
      for (size_t l = 0; l < a.idxReadout.size(); ++l) {
        const std::string sl = s + "_" + std::to_string(l);
        ai.idxReadout.push_back(in.addI32(
            ctx,
            ("idx_readout" + sl).c_str(),
            a.idxReadout[l],
            a.readoutElems));
        ai.idxNmp.push_back(
            in.addI32(ctx, ("idx_nmp" + sl).c_str(), a.idxNmp[l], a.nmpElems));
        ai.idxUpdate.push_back(in.addI32(
            ctx, ("idx_update" + sl).c_str(), a.idxUpdate[l], a.updateElems));
      }
      return ai;
    };
    const Impl::AlignInputs ai = alignInputs(a0, w8, h8, m.windowSize, "0");
    const Impl::AlignInputs ai1 =
        alignInputs(a1, w4, h4, m.refineWindowSize, "1");

    T* leftImg = batchSlice(ctx, ti, 0);
    Impl::Outputs mono = m.buildMono(ctx, leftImg, tm, ts, tp, ph, pw);
    Impl::Outputs st = m.buildStereoFeatures(ctx, ti, tm, ts);
    auto find = [](const Impl::Outputs& o, const char* k) {
      for (auto& [n, t] : o)
        if (n == k)
          return t;
      throw std::runtime_error(std::string("BridgeDepth: no output ") + k);
    };
    T* prior = find(mono, "depth_prior"); // [128, W8, H8, 1]
    Impl::Outputs outs = m.buildDpn(
        ctx,
        find(st, "backbone.fmap1_1_8"),
        find(st, "backbone.fmap2_1_8"),
        prior,
        di);

    T* disp = ggml_reshape_4d(ctx, find(outs, "dpn.proposal"), 1, nDim, w8, h8);
    auto [embed, hpos] = m.hypothesisEmbedding(
        ctx,
        find(st, "concatconv1_1_8"),
        find(st, "concatconv2_1_8"),
        find(st, "gw1_1_8"),
        find(st, "gw2_1_8"),
        disp,
        64.0f,
        ai);
    T* monoTok = ggml_reshape_4d(ctx, prior, prior->ne[0], 1, w8, h8);
    Impl::Outputs al = m.buildAlign0(ctx, embed, monoTok, hpos, disp, ai);

    T* dispEst = ggml_reshape_4d(ctx, find(al, "disp_est"), 1, 1, w4, h4);
    auto [embed1, hpos1] = m.hypothesisEmbedding(
        ctx,
        find(st, "concatconv1_1_4"),
        find(st, "concatconv2_1_4"),
        find(st, "gw1_1_4"),
        find(st, "gw2_1_4"),
        dispEst,
        128.0f,
        ai1);
    T* mono1 = ggml_reshape_4d(ctx, find(al, "align0.mono"), 128, 1, w8, h8);
    // Only the final map is a graph output, so the allocator can reuse the
    // memory of every intermediate.
    return Impl::Outputs{
        {"disp_final_padded",
         find(
             m.buildAlign1(ctx, embed1, mono1, hpos1, dispEst, ai1),
             "disp_final_padded")}};
  });

  if (m.measureOnly)
    return {};
  // InputPadder.unpad: drop the top rows and the right columns.
  const HostTensor& padded = outsHost.at("disp_final_padded");
  std::vector<float> disparity(static_cast<size_t>(h) * w);
  for (int y = 0; y < h; ++y) {
    std::copy_n(
        padded.data.data() + static_cast<size_t>(y + pad.top) * wDim,
        w,
        disparity.data() + static_cast<size_t>(y) * w);
  }
  return disparity;
}

} // namespace classification_ggml::bridgedepth
