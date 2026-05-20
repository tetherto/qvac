#pragma once

#include <array>
#include <vector>

#include <opencv2/core.hpp>

#include "model-interface/easyocr/pipeline/steps.hpp"

namespace doctr::ggml::pipeline {

using easyocr::ggml::pipeline::PipelineContext;
using easyocr::ggml::pipeline::InferredText;
using easyocr::ggml::pipeline::fourPointTransform;

enum class DecodingMethod { CTC, ATTENTION };

struct StepDoctrDetectionOutput {
    PipelineContext context;
    std::vector<std::array<cv::Point2f, 4>> polygons;
    std::vector<float> polygonConfidences;
    cv::Mat probMap;
    int paddedW{0};
    int paddedH{0};
    int padLeft{0};
    int padTop{0};
};

} // namespace doctr::ggml::pipeline
