#pragma once

// Loaded weights for the CRAFT detector, with every BatchNorm pre-folded into
// the preceding Conv2d so the runtime graph is BN-free.
//
// Naming
// ------
// Each conv layer is identified by the same dotted path used in the upstream
// PyTorch state_dict (see `easyocr/craft.py` and `easyocr/model/modules.py`).
// For instance:
//   "basenet.slice1.0"   first Conv2d in slice1 (3 -> 64, k=3, p=1)
//   "basenet.slice5.1"   dilated Conv2d in slice5 (512 -> 1024, k=3, p=6, d=6)
//   "upconv2.conv.3"     3x3 Conv2d in upconv2's double_conv block
//   "conv_cls.4"         3rd Conv2d in the output head
//
// For each conv we always have two tensors: the kernel and the bias.  When
// the conv is followed by BatchNorm in the Python source, both are *pre-
// folded* using
//
//     scale = gamma / sqrt(running_var + eps)
//     W'    = W * scale[oc]                      (per output channel)
//     b'    = (b - running_mean) * scale + beta
//
// where eps == 1e-5 (the PyTorch BatchNorm2d default).  After folding the
// graph never has to evaluate a BatchNorm op.
//
// Lifetime
// --------
// Every tensor pointer returned by this class lives in a single backend
// buffer owned by the CraftWeights instance.  The pointers remain valid for
// the lifetime of the CraftWeights and become invalid on destruction.

#include <memory>
#include <string>
#include <unordered_map>

struct ggml_context;
struct ggml_tensor;
using ggml_backend_t = struct ggml_backend*;
using ggml_backend_buffer_t = struct ggml_backend_buffer*;

namespace easyocr::ggml {

class GgufLoader;

class CraftWeights {
public:
  // Constructs the weights and uploads them to the given backend.  After
  // construction, ok() reports success.  On failure, the error string is
  // available via err().
  //
  // The loader must have been opened with load_tensor_data=true so that
  // raw weight bytes are accessible.
  CraftWeights(const GgufLoader& loader, ggml_backend_t backend);
  ~CraftWeights();

  CraftWeights(const CraftWeights&) = delete;
  CraftWeights& operator=(const CraftWeights&) = delete;
  CraftWeights(CraftWeights&&) = delete;
  CraftWeights& operator=(CraftWeights&&) = delete;

  [[nodiscard]] bool ok() const noexcept { return err_.empty(); }
  [[nodiscard]] const std::string& err() const noexcept { return err_; }

  // Returns the (folded) kernel tensor for the conv at `path`, or nullptr
  // if absent. `path` must NOT include a trailing ".weight" suffix.
  [[nodiscard]] ::ggml_tensor* w(const std::string& path) const noexcept;

  // Returns the (folded) bias tensor for the conv at `path`, or nullptr.
  [[nodiscard]] ::ggml_tensor* b(const std::string& path) const noexcept;

  // Diagnostic accessors.
  [[nodiscard]] int n_loaded() const noexcept;

private:
  void build_(const GgufLoader& loader, ggml_backend_t backend);

  std::unordered_map<std::string, ::ggml_tensor*> w_;
  std::unordered_map<std::string, ::ggml_tensor*> b_;
  ::ggml_context* ctx_ = nullptr;
  ::ggml_backend_buffer_t buf_ = nullptr;
  std::string err_;
};

} // namespace easyocr::ggml
