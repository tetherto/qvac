#pragma once

// CRAFT detector compute graph.
//
// `build_craft` emits a ggml graph that mirrors easyocr/craft.py layer-by-
// layer.  All BatchNorm parameters are assumed to have been folded into the
// preceding Conv2d at weight-load time (see CraftWeights).
//
// Input  : x = [W, H, 3, 1] F32 (NCHW with W innermost, ggml order)
// Output : NHWC heatmap pair [2, W/2, H/2, 1]   (the final ggml tensor's ne)
//          which is the same memory layout PyTorch produces with
//          `out.permute(0, 2, 3, 1)`, matching the contract in
//          `@qvac/ocr-onnx/.../StepDetectionInference::extractOutputFromOrtValue`.
//
// Optional `taps` lets a test harness capture intermediate activations for
// per-layer comparison against the PyTorch oracle.

#include <string>
#include <unordered_map>

struct ggml_context;
struct ggml_tensor;

namespace easyocr::ggml {

class CraftWeights;

// Names of the intermediate taps the graph builder will populate when given
// a non-null `taps` map.  These names match the layer names dumped by
// tests/reference/dump_craft_reference.py so the C++ test can iterate
// reference files and look up the corresponding tap.
namespace craft_taps {
inline constexpr const char* kBasenetSlice1 = "basenet_slice1";
inline constexpr const char* kBasenetSlice2 = "basenet_slice2";
inline constexpr const char* kBasenetSlice3 = "basenet_slice3";
inline constexpr const char* kBasenetSlice4 = "basenet_slice4";
inline constexpr const char* kBasenetSlice5 = "basenet_slice5";
inline constexpr const char* kUpconv1 = "upconv1";
inline constexpr const char* kInterp2 =
    "interp2"; // diagnostic: interp before upconv2
inline constexpr const char* kCat2 = "cat2"; // diagnostic: cat before upconv2
inline constexpr const char* kUpconv2 = "upconv2";
inline constexpr const char* kUpconv3 = "upconv3";
inline constexpr const char* kUpconv4 = "upconv4";  // == `feature` (NCHW)
inline constexpr const char* kConvCls = "conv_cls"; // NCHW [1, 2, H/2, W/2]
inline constexpr const char* kOutputNhwc = "output_nhwc";
} // namespace craft_taps

::ggml_tensor* build_craft(
    ::ggml_context* ctx, const CraftWeights& weights, ::ggml_tensor* x,
    std::unordered_map<std::string, ::ggml_tensor*>* taps = nullptr);

} // namespace easyocr::ggml
