#pragma once

namespace doctr::ggml::pipeline {

// Constants-only shim — mirrors the RECOG_* values from the ONNX package so
// StepDoctrRecognitionGGML can reference them without depending on ocr-onnx.
struct StepDoctrRecognition {
    static constexpr int RECOG_HEIGHT = 32;
    static constexpr int RECOG_WIDTH  = 128;
};

} // namespace doctr::ggml::pipeline
