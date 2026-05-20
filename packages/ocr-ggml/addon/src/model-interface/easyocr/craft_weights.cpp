#include "craft_weights.hpp"

#include <cmath>
#include <cstring>
#include <sstream>
#include <stdexcept>
#include <vector>

#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml.h"
#include "gguf_loader.hpp"

// NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index)
// BatchNorm fold loops iterate over raw tensor byte buffers with pointer
// arithmetic; bounds invariants are checked against the GGUF metadata.

namespace easyocr::ggml {

namespace {

// PyTorch's nn.BatchNorm2d default (`eps=1e-5`).
constexpr float kBnEps = 1e-5F;

// Static inventory of all conv layers in CRAFT, in source order.  For each
// row, `bn` is the dotted state-dict path of the immediately following
// BatchNorm2d, or empty for plain convs (slice5 internals + conv_cls).
struct ConvDef {
  const char* conv;
  const char* bn; // "" => no BN
};

// NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,hicpp-avoid-c-arrays,modernize-avoid-c-arrays) - kept as C array so kNumConvs deduces below
constexpr ConvDef kConvInventory[] = {
    // basenet.slice1: 4 conv-BN pairs (idx 0+1, 3+4, 7+8, 10+11)
    {.conv = "basenet.slice1.0", .bn = "basenet.slice1.1"},
    {.conv = "basenet.slice1.3", .bn = "basenet.slice1.4"},
    {.conv = "basenet.slice1.7", .bn = "basenet.slice1.8"},
    {.conv = "basenet.slice1.10", .bn = "basenet.slice1.11"},
    // basenet.slice2: 2 conv-BN pairs
    {.conv = "basenet.slice2.14", .bn = "basenet.slice2.15"},
    {.conv = "basenet.slice2.17", .bn = "basenet.slice2.18"},
    // basenet.slice3: 3 conv-BN pairs
    {.conv = "basenet.slice3.20", .bn = "basenet.slice3.21"},
    {.conv = "basenet.slice3.24", .bn = "basenet.slice3.25"},
    {.conv = "basenet.slice3.27", .bn = "basenet.slice3.28"},
    // basenet.slice4: 3 conv-BN pairs
    {.conv = "basenet.slice4.30", .bn = "basenet.slice4.31"},
    {.conv = "basenet.slice4.34", .bn = "basenet.slice4.35"},
    {.conv = "basenet.slice4.37", .bn = "basenet.slice4.38"},
    // basenet.slice5: NO BN (raw fc6/fc7-as-conv)
    {.conv = "basenet.slice5.1", .bn = ""},
    {.conv = "basenet.slice5.2", .bn = ""},
    // upconv1..4: each double_conv has a 1x1 conv-BN and a 3x3 conv-BN
    {.conv = "upconv1.conv.0", .bn = "upconv1.conv.1"},
    {.conv = "upconv1.conv.3", .bn = "upconv1.conv.4"},
    {.conv = "upconv2.conv.0", .bn = "upconv2.conv.1"},
    {.conv = "upconv2.conv.3", .bn = "upconv2.conv.4"},
    {.conv = "upconv3.conv.0", .bn = "upconv3.conv.1"},
    {.conv = "upconv3.conv.3", .bn = "upconv3.conv.4"},
    {.conv = "upconv4.conv.0", .bn = "upconv4.conv.1"},
    {.conv = "upconv4.conv.3", .bn = "upconv4.conv.4"},
    // conv_cls: NO BN (5 raw convs interleaved with ReLU)
    {.conv = "conv_cls.0", .bn = ""},
    {.conv = "conv_cls.2", .bn = ""},
    {.conv = "conv_cls.4", .bn = ""},
    {.conv = "conv_cls.6", .bn = ""},
    {.conv = "conv_cls.8", .bn = ""},
};

constexpr size_t kNumConvs = sizeof(kConvInventory) / sizeof(kConvInventory[0]);

std::vector<float> to_f32_vector(const ::ggml_tensor* t) {
  const int64_t ne0 = t->ne[0];
  const int64_t nrows = ggml_nrows(t);
  std::vector<float> out(static_cast<size_t>(ne0 * nrows), 0.0F);
  const auto* traits = ggml_get_type_traits(t->type);
  for (int64_t r = 0; r < nrows; ++r) {
    const char* src_row = static_cast<const char*>(t->data) + (r * t->nb[1]);
    float* dst_row = out.data() + static_cast<size_t>(r * ne0);
    if (t->type == GGML_TYPE_F32) {
      std::memcpy(dst_row, src_row, static_cast<size_t>(ne0) * sizeof(float));
    } else if (traits != nullptr && traits->to_float != nullptr) {
      traits->to_float(src_row, dst_row, ne0);
    } else {
      throw std::runtime_error("unsupported tensor type for to_f32_vector");
    }
  }
  return out;
}

} // namespace

CraftWeights::CraftWeights(const GgufLoader& loader, ggml_backend_t backend) {
  build_(loader, backend);
}

CraftWeights::~CraftWeights() {
  if (buf_) {
    ggml_backend_buffer_free(buf_);
    buf_ = nullptr;
  }
  if (ctx_) {
    ggml_free(ctx_);
    ctx_ = nullptr;
  }
}

::ggml_tensor* CraftWeights::w(const std::string& path) const noexcept {
  auto it = w_.find(path);
  return it == w_.end() ? nullptr : it->second;
}

::ggml_tensor* CraftWeights::b(const std::string& path) const noexcept {
  auto it = b_.find(path);
  return it == b_.end() ? nullptr : it->second;
}

int CraftWeights::n_loaded() const noexcept {
  return static_cast<int>(w_.size());
}

void CraftWeights::build_(const GgufLoader& loader, ggml_backend_t backend) {
  if (!loader.ok()) {
    err_ = "GgufLoader is not ok";
    return;
  }
  if (backend == nullptr) {
    err_ = "backend is null";
    return;
  }

  // --- Step 1: declare every destination tensor in our own ctx --------------
  // We need 2 tensors per conv (W + b) and a small headroom margin.
  ggml_init_params ctx_params{
      .mem_size = ggml_tensor_overhead() * ((kNumConvs * 2) + 16),
      .mem_buffer = nullptr,
      .no_alloc = true,
  };
  ctx_ = ggml_init(ctx_params);
  if (ctx_ == nullptr) {
    err_ = "ggml_init failed for weights ctx";
    return;
  }

  for (const auto& d : kConvInventory) {
    auto* w_src = loader.get_tensor(std::string(d.conv) + ".weight");
    if (w_src == nullptr) {
      std::ostringstream os;
      os << "missing tensor: " << d.conv << ".weight";
      err_ = os.str();
      return;
    }
    // ggml stores conv kernels as [KW, KH, IC, OC] (i.e. the GGUF on-disk
    // dim order, which reverses PyTorch's [OC, IC, KH, KW]).
    const int64_t kw = w_src->ne[0];
    const int64_t kh = w_src->ne[1];
    const int64_t ic = w_src->ne[2];
    const int64_t oc = w_src->ne[3];

    auto* w_dst = ggml_new_tensor_4d(ctx_, GGML_TYPE_F32, kw, kh, ic, oc);
    ggml_set_name(w_dst, (std::string(d.conv) + ".W").c_str());
    w_[d.conv] = w_dst;

    auto* b_dst = ggml_new_tensor_1d(ctx_, GGML_TYPE_F32, oc);
    ggml_set_name(b_dst, (std::string(d.conv) + ".B").c_str());
    b_[d.conv] = b_dst;
  }

  // --- Step 2: ask the backend to allocate one buffer for all of them ------
  buf_ = ggml_backend_alloc_ctx_tensors(ctx_, backend);
  if (buf_ == nullptr) {
    err_ = "ggml_backend_alloc_ctx_tensors failed";
    return;
  }

  // --- Step 3: compute folded weights + upload -----------------------------
  std::vector<float> w_folded;
  std::vector<float> b_folded;
  for (const auto& d : kConvInventory) {
    const std::string conv_path = d.conv;

    auto* w_src = loader.get_tensor(conv_path + ".weight");
    auto* b_src = loader.get_tensor(conv_path + ".bias");
    // CRAFT convs always have bias, but be defensive.
    if (w_src == nullptr) {
      std::ostringstream os;
      os << "missing tensor: " << conv_path << ".weight";
      err_ = os.str();
      return;
    }
    if (w_src->data == nullptr) {
      std::ostringstream os;
      os << "tensor data not loaded: " << conv_path
         << ".weight (open the GgufLoader with load_tensor_data=true)";
      err_ = os.str();
      return;
    }

    const int64_t kw = w_src->ne[0];
    const int64_t kh = w_src->ne[1];
    const int64_t ic = w_src->ne[2];
    const int64_t oc = w_src->ne[3];
    const int64_t per_oc = kw * kh * ic;
    const int64_t total_w = oc * per_oc;

    w_folded.assign(static_cast<size_t>(total_w), 0.0F);
    b_folded.assign(static_cast<size_t>(oc), 0.0F);

    const std::vector<float> w_src_f32 = to_f32_vector(w_src);
    const std::vector<float> b_src_f32 =
        b_src ? to_f32_vector(b_src) : std::vector<float>{};
    const float* W = w_src_f32.data();
    const float* B = b_src_f32.empty() ? nullptr : b_src_f32.data();

    if (d.bn[0] == '\0') {
      // Plain conv: copy as-is.
      std::memcpy(
          w_folded.data(), W, static_cast<size_t>(total_w) * sizeof(float));
      if (B != nullptr) {
        std::memcpy(
            b_folded.data(), B, static_cast<size_t>(oc) * sizeof(float));
      }
    } else {
      const std::string bn_path = d.bn;
      auto* gamma_t = loader.get_tensor(bn_path + ".weight");
      auto* beta_t = loader.get_tensor(bn_path + ".bias");
      auto* mu_t = loader.get_tensor(bn_path + ".running_mean");
      auto* var_t = loader.get_tensor(bn_path + ".running_var");
      if (gamma_t == nullptr || beta_t == nullptr || mu_t == nullptr ||
          var_t == nullptr) {
        std::ostringstream os;
        os << "missing BN tensor under " << bn_path;
        err_ = os.str();
        return;
      }
      const std::vector<float> gamma_f32 = to_f32_vector(gamma_t);
      const std::vector<float> beta_f32 = to_f32_vector(beta_t);
      const std::vector<float> mu_f32 = to_f32_vector(mu_t);
      const std::vector<float> var_f32 = to_f32_vector(var_t);
      const float* gamma = gamma_f32.data();
      const float* beta = beta_f32.data();
      const float* mu = mu_f32.data();
      const float* var = var_f32.data();

      for (int64_t o = 0; o < oc; ++o) {
        const float scale = gamma[o] / std::sqrt(var[o] + kBnEps);
        const float b_orig = B != nullptr ? B[o] : 0.0F;
        // OC is the slowest-varying axis in row-major [OC,IC,KH,KW] data;
        // a per-OC scalar multiplies one contiguous span of length per_oc.
        const float* w_in = W + (o * per_oc);
        float* w_out = w_folded.data() + (o * per_oc);
        for (int64_t k = 0; k < per_oc; ++k) {
          w_out[k] = w_in[k] * scale;
        }
        b_folded[static_cast<size_t>(o)] = ((b_orig - mu[o]) * scale) + beta[o];
      }
    }

    ggml_backend_tensor_set(
        w_[conv_path], w_folded.data(), 0, ggml_nbytes(w_[conv_path]));
    ggml_backend_tensor_set(
        b_[conv_path], b_folded.data(), 0, ggml_nbytes(b_[conv_path]));
  }
}

} // namespace easyocr::ggml

// NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index)
