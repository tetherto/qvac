#pragma once

// CRNN gen-2 recognizer compute graph.
//
// `build_crnn_gen2` mirrors `easyocr/model/vgg_model.py`'s `Model.forward`:
//
// The graph is batched over N crops (QVAC-19796): a batch of N same-width
// crops is computed in a single graph execution. N==1 reduces to the original
// single-crop behaviour.
//
//   input  ggml ne [W, H=64, 1, N]   (PyTorch NCHW [N, 1, 64, W])
//          │
//          ▼  VGG_FeatureExtractor (modules.py)
//   visual ggml ne [W/4 - 1, H'=3, 256, N]
//          │
//          ▼  AdaptiveAvgPool2d((None,1)) + permute + reshape
//          │   == mean over the H'=3 axis, leaving [W/4-1, 256] features per N
//   seq    ggml ne [256, T=W/4-1, N]    (PyTorch [N, T, 256])
//          │
//          ▼  SequenceModeling.0 = BidirectionalLSTM(256, 256, 256)
//          ▼  SequenceModeling.1 = BidirectionalLSTM(256, 256, 256)
//   ctx    ggml ne [256, T, N]
//          │
//          ▼  Prediction = Linear(256, 97)
//   logits ggml ne [97, T, N]           (PyTorch [N, T, 97])
//
// The returned tensor is the final logits, with `T` set by the input
// width so the graph supports any input size that survives the
// FeatureExtractor's spatial downsampling (input W must satisfy
// `(W / 4) - 1 >= 1`, i.e. W >= 8).

#include <string>
#include <unordered_map>

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length)
struct ggml_context;
struct ggml_tensor;
// CRNN gen-2 header declares the public graph-builder API; identifiers
// mirror upstream PyTorch state-dict paths (snake_case) and contain
// architecture-defined constants (256, 64, T=W/4-1).

namespace easyocr::ggml {

class CrnnGen2Weights;

namespace crnn_taps {
inline constexpr const char* kVisual =
    "visual_feature"; // post-FeatureExtraction
inline constexpr const char* kSequence = "sequence_input"; // post-AAP+squeeze
inline constexpr const char* kBilstm0 = "bilstm0"; // post-SequenceModeling.0
inline constexpr const char* kBilstm1 = "bilstm1"; // post-SequenceModeling.1
inline constexpr const char* kLogits = "logits";   // final
} // namespace crnn_taps

::ggml_tensor* build_crnn_gen2(
    ::ggml_context* ctx, const CrnnGen2Weights& weights, ::ggml_tensor* x,
    std::unordered_map<std::string, ::ggml_tensor*>* taps = nullptr);

} // namespace easyocr::ggml

// NOLINTEND(readability-identifier-naming,readability-identifier-length)
