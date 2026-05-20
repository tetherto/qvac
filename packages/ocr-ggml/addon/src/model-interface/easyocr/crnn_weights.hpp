#pragma once

// Loaded weights for the CRNN gen-2 recognizer.
//
// The two classes share the same shape:
//
//   - `w(path)` / `b(path)` look up Conv2d kernel + bias by their PyTorch
//     state-dict path. Conv layers followed by BatchNorm in the source
//     are pre-folded at load time so the runtime graph is BN-free.
//   - LSTM weights/biases are looked up by their full state-dict path,
//     unmodified (no fold). PyTorch's `bias_ih + bias_hh` redundancy is
//     preserved verbatim so weights drop in 1:1.
//   - The Linear inside each `BidirectionalLSTM` and the final
//     `Prediction` Linear come through as plain (W, b) pairs.
//
// `CrnnGen2Weights` covers the VGG-backed gen-2 family (english_g2,
// latin_g2, korean_g2, ...).

#include <memory>
#include <string>
#include <unordered_map>

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length)
struct ggml_context;
struct ggml_tensor;
using ggml_backend_t = struct ggml_backend*;
using ggml_backend_buffer_t = struct ggml_backend_buffer*;
// CrnnGen2Weights API uses snake_case (n_loaded, w_, b_, t_) to mirror
// upstream PyTorch state-dict names.

namespace easyocr::ggml {

class GgufLoader;

class CrnnGen2Weights {
public:
  CrnnGen2Weights(const GgufLoader& loader, ggml_backend_t backend);
  ~CrnnGen2Weights();

  CrnnGen2Weights(const CrnnGen2Weights&) = delete;
  CrnnGen2Weights& operator=(const CrnnGen2Weights&) = delete;
  CrnnGen2Weights(CrnnGen2Weights&&) = delete;
  CrnnGen2Weights& operator=(CrnnGen2Weights&&) = delete;

  [[nodiscard]] bool ok() const noexcept { return err_.empty(); }
  [[nodiscard]] const std::string& err() const noexcept { return err_; }

  // Conv2d / Linear kernel + bias by PyTorch state-dict path
  // (e.g. "FeatureExtraction.ConvNet.0", "Prediction").
  [[nodiscard]] ::ggml_tensor* w(const std::string& path) const noexcept;
  [[nodiscard]] ::ggml_tensor* b(const std::string& path) const noexcept;

  // LSTM tensors by full state-dict path
  // (e.g. "SequenceModeling.0.rnn.weight_ih_l0_reverse",
  //       "SequenceModeling.0.rnn.bias_hh_l0").
  // Returns nullptr if absent.
  [[nodiscard]] ::ggml_tensor* t(const std::string& path) const noexcept;

  [[nodiscard]] int n_loaded() const noexcept;

private:
  void build_(const GgufLoader& loader, ggml_backend_t backend);

  std::unordered_map<std::string, ::ggml_tensor*> w_;
  std::unordered_map<std::string, ::ggml_tensor*> b_;
  std::unordered_map<std::string, ::ggml_tensor*> t_;
  ::ggml_context* ctx_ = nullptr;
  ::ggml_backend_buffer_t buf_ = nullptr;
  std::string err_;
};

} // namespace easyocr::ggml

// NOLINTEND(readability-identifier-naming,readability-identifier-length)
