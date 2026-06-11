#include "crnn_weights.hpp"

#include <cmath>
#include <cstring>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "ggml.h"
#include "gguf_loader.hpp"
#include "kernel_precision.hpp"

// NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,readability-identifier-naming,readability-identifier-length)
// BatchNorm fold loops iterate over raw tensor byte buffers with pointer
// arithmetic and snake_case identifiers matching upstream PyTorch
// state-dict paths.

namespace easyocr::ggml {

namespace {

constexpr float kBnEps = 1e-5F;

// Lengths of the PyTorch state-dict tensor-name suffixes that
// upload_weights / declare_weights strip when reverse-mapping tensors back
// to their conv prefix.
constexpr size_t kWeightSuffixLen = 7; // strlen(".weight")
constexpr size_t kBiasSuffixLen = 5;   // strlen(".bias")

// Spec for one conv, optionally followed by BN.  `bn_path` is the dotted
// state-dict path of the BN module (empty for plain convs).
struct ConvSpec {
  std::string conv_path; // e.g. "FeatureExtraction.ConvNet.layer1.0.conv1"
  std::string bn_path;   // e.g. "FeatureExtraction.ConvNet.layer1.0.bn1" or ""
};

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

// Verbatim-load list for gen-2: everything after the
// feature extractor (LSTM weights/biases, BiLSTM linear heads, Prediction).
const std::vector<std::string>& verbatim_paths_after_feature_extractor() {
  static const std::vector<std::string> v = {
      "SequenceModeling.0.rnn.weight_ih_l0",
      "SequenceModeling.0.rnn.weight_hh_l0",
      "SequenceModeling.0.rnn.bias_ih_l0",
      "SequenceModeling.0.rnn.bias_hh_l0",
      "SequenceModeling.0.rnn.weight_ih_l0_reverse",
      "SequenceModeling.0.rnn.weight_hh_l0_reverse",
      "SequenceModeling.0.rnn.bias_ih_l0_reverse",
      "SequenceModeling.0.rnn.bias_hh_l0_reverse",
      "SequenceModeling.0.linear.weight",
      "SequenceModeling.0.linear.bias",
      "SequenceModeling.1.rnn.weight_ih_l0",
      "SequenceModeling.1.rnn.weight_hh_l0",
      "SequenceModeling.1.rnn.bias_ih_l0",
      "SequenceModeling.1.rnn.bias_hh_l0",
      "SequenceModeling.1.rnn.weight_ih_l0_reverse",
      "SequenceModeling.1.rnn.weight_hh_l0_reverse",
      "SequenceModeling.1.rnn.bias_ih_l0_reverse",
      "SequenceModeling.1.rnn.bias_hh_l0_reverse",
      "SequenceModeling.1.linear.weight",
      "SequenceModeling.1.linear.bias",
      "Prediction.weight",
      "Prediction.bias",
  };
  return v;
}

// Run the standard BN-fold + verbatim-copy load given a conv inventory and
// a prebuilt context with destination tensors already declared.  Returns
// empty string on success; non-empty error message on failure.
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
std::string upload_weights(
    const GgufLoader& loader, const std::vector<ConvSpec>& convs,
    const std::vector<std::string>& verbatim_paths,
    std::unordered_map<std::string, ::ggml_tensor*>& w_,
    std::unordered_map<std::string, ::ggml_tensor*>& b_,
    std::unordered_map<std::string, ::ggml_tensor*>& t_) {

  std::vector<float> w_folded;
  std::vector<float> b_folded;

  for (const auto& d : convs) {
    auto* w_src = loader.get_tensor(d.conv_path + ".weight");
    auto* b_src = loader.get_tensor(d.conv_path + ".bias"); // may be null

    if (w_src == nullptr) {
      return "missing tensor: " + d.conv_path + ".weight";
    }
    if (w_src->data == nullptr) {
      return "tensor data not loaded for " + d.conv_path +
             ".weight (open the GgufLoader with load_tensor_data=true)";
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
        b_src != nullptr ? to_f32_vector(b_src) : std::vector<float>{};
    const float* W = w_src_f32.data();
    const float* B = b_src_f32.empty() ? nullptr : b_src_f32.data();

    if (d.bn_path.empty()) {
      std::memcpy(
          w_folded.data(), W, static_cast<size_t>(total_w) * sizeof(float));
      if (B != nullptr) {
        std::memcpy(
            b_folded.data(), B, static_cast<size_t>(oc) * sizeof(float));
      }
    } else {
      auto* gamma_t = loader.get_tensor(d.bn_path + ".weight");
      auto* beta_t = loader.get_tensor(d.bn_path + ".bias");
      auto* mu_t = loader.get_tensor(d.bn_path + ".running_mean");
      auto* var_t = loader.get_tensor(d.bn_path + ".running_var");
      if (gamma_t == nullptr || beta_t == nullptr || mu_t == nullptr ||
          var_t == nullptr) {
        return "missing BN tensor under " + d.bn_path;
      }
      const std::vector<float> gamma_f32 = to_f32_vector(gamma_t);
      const std::vector<float> beta_f32 = to_f32_vector(beta_t);
      const std::vector<float> mu_f32 = to_f32_vector(mu_t);
      const std::vector<float> var_f32 = to_f32_vector(var_t);
      const size_t oc_sz = static_cast<size_t>(oc);
      if (gamma_f32.size() != oc_sz || beta_f32.size() != oc_sz ||
          mu_f32.size() != oc_sz || var_f32.size() != oc_sz) {
        return "BN tensor size mismatch for " + d.bn_path;
      }
      const float* gamma = gamma_f32.data();
      const float* beta = beta_f32.data();
      const float* mu = mu_f32.data();
      const float* var = var_f32.data();

      for (int64_t o = 0; o < oc; ++o) {
        const float scale = gamma[o] / std::sqrt(var[o] + kBnEps);
        const float b_orig = B != nullptr ? B[o] : 0.0F;
        const float* w_in = W + (o * per_oc);
        float* w_out = w_folded.data() + (o * per_oc);
        for (int64_t k = 0; k < per_oc; ++k) {
          w_out[k] = w_in[k] * scale;
        }
        b_folded[static_cast<size_t>(o)] = ((b_orig - mu[o]) * scale) + beta[o];
      }
    }

    ocr_upload_kernel(w_[d.conv_path], w_folded);
    ggml_backend_tensor_set(
        b_[d.conv_path], b_folded.data(), 0, ggml_nbytes(b_[d.conv_path]));
  }

  for (const auto& full_name : verbatim_paths) {
    auto* src = loader.get_tensor(full_name);
    if (src == nullptr) {
      return "missing tensor: " + full_name;
    }
    if (src->data == nullptr) {
      return "tensor data not loaded for " + full_name;
    }
    ::ggml_tensor* dst = nullptr;
    if (auto it = t_.find(full_name); it != t_.end()) {
      dst = it->second;
    } else if (full_name.ends_with(".weight")) {
      dst = w_[full_name.substr(0, full_name.size() - kWeightSuffixLen)];
    } else if (full_name.ends_with(".bias")) {
      dst = b_[full_name.substr(0, full_name.size() - kBiasSuffixLen)];
    }
    if (dst == nullptr) {
      return "internal: no destination for " + full_name;
    }
    const std::vector<float> src_f32 = to_f32_vector(src);
    ggml_backend_tensor_set(dst, src_f32.data(), 0, ggml_nbytes(dst));
  }
  return "";
}

// Declare destination tensors for `convs` and `verbatim_paths` in `ctx`,
// matching the on-disk shape.  Populates the maps so `upload_weights` can
// then fill them.
std::string declare_weights(
    const GgufLoader& loader, ::ggml_context* ctx, ggml_type kernel_type,
    const std::vector<ConvSpec>& convs,
    const std::vector<std::string>& verbatim_paths,
    std::unordered_map<std::string, ::ggml_tensor*>& w_,
    std::unordered_map<std::string, ::ggml_tensor*>& b_,
    std::unordered_map<std::string, ::ggml_tensor*>& t_) {

  // `kernel_type` (F16 on fast-F16 backends, else F32) is chosen by the caller;
  // bias stays F32.
  for (const auto& d : convs) {
    auto* w_src = loader.get_tensor(d.conv_path + ".weight");
    if (w_src == nullptr) {
      return "missing tensor: " + d.conv_path + ".weight";
    }
    const int64_t kw = w_src->ne[0];
    const int64_t kh = w_src->ne[1];
    const int64_t ic = w_src->ne[2];
    const int64_t oc = w_src->ne[3];
    auto* w_dst = ggml_new_tensor_4d(ctx, kernel_type, kw, kh, ic, oc);
    ggml_set_name(w_dst, (d.conv_path + ".W").c_str());
    w_[d.conv_path] = w_dst;
    auto* b_dst = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, oc);
    ggml_set_name(b_dst, (d.conv_path + ".B").c_str());
    b_[d.conv_path] = b_dst;
  }
  for (const auto& full_name : verbatim_paths) {
    auto* src = loader.get_tensor(full_name);
    if (src == nullptr) {
      return "missing tensor: " + full_name;
    }
    ::ggml_tensor* dst = nullptr;
    const int n_dims = ggml_n_dims(src);
    if (n_dims == 1) {
      dst = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, src->ne[0]);
    } else if (n_dims == 2) {
      dst = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, src->ne[0], src->ne[1]);
    } else {
      return "unsupported tensor rank for " + full_name;
    }
    ggml_set_name(dst, full_name.c_str());

    const bool is_w = full_name.ends_with(".weight");
    const bool is_b = full_name.ends_with(".bias");
    const bool is_lstm = full_name.find(".rnn.") != std::string::npos;
    if (is_w && !is_lstm) {
      w_[full_name.substr(0, full_name.size() - kWeightSuffixLen)] = dst;
    } else if (is_b && !is_lstm) {
      b_[full_name.substr(0, full_name.size() - kBiasSuffixLen)] = dst;
    } else {
      t_[full_name] = dst;
    }
  }
  return "";
}

// ---------- gen-2 (VGG) inventory ----------
const std::vector<ConvSpec>& gen2_convs() {
  static const auto p = [] {
    const std::string base = "FeatureExtraction.ConvNet.";
    return std::vector<ConvSpec>{
        {.conv_path = base + "0", .bn_path = ""},
        {.conv_path = base + "3", .bn_path = ""},
        {.conv_path = base + "6", .bn_path = ""},
        {.conv_path = base + "8", .bn_path = ""},
        {.conv_path = base + "11", .bn_path = base + "12"},
        {.conv_path = base + "14", .bn_path = base + "15"},
        {.conv_path = base + "18", .bn_path = ""},
    };
  }();
  return p;
}

} // namespace

CrnnGen2Weights::CrnnGen2Weights(
    const GgufLoader& loader, ggml_backend_t backend) {
  build_(loader, backend);
}

CrnnGen2Weights::~CrnnGen2Weights() {
  if (buf_ != nullptr) {
    ggml_backend_buffer_free(buf_);
    buf_ = nullptr;
  }
  if (ctx_ != nullptr) {
    ggml_free(ctx_);
    ctx_ = nullptr;
  }
}

::ggml_tensor* CrnnGen2Weights::w(const std::string& path) const noexcept {
  auto it = w_.find(path);
  return it == w_.end() ? nullptr : it->second;
}
::ggml_tensor* CrnnGen2Weights::b(const std::string& path) const noexcept {
  auto it = b_.find(path);
  return it == b_.end() ? nullptr : it->second;
}
::ggml_tensor* CrnnGen2Weights::t(const std::string& path) const noexcept {
  auto it = t_.find(path);
  return it == t_.end() ? nullptr : it->second;
}
int CrnnGen2Weights::n_loaded() const noexcept {
  return static_cast<int>(w_.size() + t_.size());
}

namespace {
void build_crnn_weights_impl(
    const GgufLoader& loader, ggml_backend_t backend,
    const std::vector<ConvSpec>& convs,
    std::unordered_map<std::string, ::ggml_tensor*>& w_,
    std::unordered_map<std::string, ::ggml_tensor*>& b_,
    std::unordered_map<std::string, ::ggml_tensor*>& t_, ::ggml_context*& ctx_,
    ::ggml_backend_buffer_t& buf_, std::string& err_) {

  if (!loader.ok()) {
    err_ = "GgufLoader is not ok";
    return;
  }
  if (backend == nullptr) {
    err_ = "backend is null";
    return;
  }

  const auto& verbatim = verbatim_paths_after_feature_extractor();

  const size_t n_dst_estimate = (convs.size() * 2) + verbatim.size() + 16;
  ggml_init_params ctx_params{
      .mem_size = ggml_tensor_overhead() * n_dst_estimate,
      .mem_buffer = nullptr,
      .no_alloc = true,
  };
  ctx_ = ggml_init(ctx_params);
  if (ctx_ == nullptr) {
    err_ = "ggml_init failed";
    return;
  }

  // Conv kernel storage type (F16 on fast-F16 backends, else F32; the env
  // overrides force one way); bias always stays F32.
  const ggml_type kernel_type =
      ocr_kernels_use_f16(
          backend, "OCR_GGML_CRNN_KERNEL_F32", "OCR_GGML_CRNN_KERNEL_F16")
          ? GGML_TYPE_F16
          : GGML_TYPE_F32;

  if (auto e = declare_weights(
          loader, ctx_, kernel_type, convs, verbatim, w_, b_, t_);
      !e.empty()) {
    err_ = e;
    return;
  }

  buf_ = ggml_backend_alloc_ctx_tensors(ctx_, backend);
  if (buf_ == nullptr) {
    err_ = "ggml_backend_alloc_ctx_tensors failed";
    return;
  }

  if (auto e = upload_weights(loader, convs, verbatim, w_, b_, t_);
      !e.empty()) {
    err_ = e;
    return;
  }
}
} // namespace

void CrnnGen2Weights::build_(const GgufLoader& loader, ggml_backend_t backend) {
  build_crnn_weights_impl(
      loader, backend, gen2_convs(), w_, b_, t_, ctx_, buf_, err_);
}

} // namespace easyocr::ggml

// NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-bounds-constant-array-index,readability-identifier-naming,readability-identifier-length)
