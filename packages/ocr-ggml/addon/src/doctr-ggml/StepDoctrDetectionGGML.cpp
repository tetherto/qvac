#include "StepDoctrDetectionGGML.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <thread>
#include <string>
#include <vector>

#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <ggml.h>
#include <opencv2/opencv.hpp>

#include "pipeline/qlog.hpp"
#include "easyocr-ggml/pipeline/steps.hpp"

namespace doctr::ggml::pipeline {

namespace {

// DocTR detection normalisation constants (from HuggingFace db_resnet50 config).
const cv::Scalar DOCTR_DET_MEAN(0.798, 0.785, 0.772);
const cv::Scalar DOCTR_DET_STD(0.264, 0.2749, 0.287);
constexpr double PIXEL_MAX = 255.0;

// Mean probability inside a bounding rectangle (assume_straight_pages=True).
float boxScore(const cv::Mat& probMap, const cv::Rect& bbox) {
    const int x0 = std::max(0, bbox.x);
    const int y0 = std::max(0, bbox.y);
    const int x1 = std::min(probMap.cols - 1, bbox.x + bbox.width);
    const int y1 = std::min(probMap.rows - 1, bbox.y + bbox.height);
    if (x1 <= x0 || y1 <= y0) {
        return 0.0F;
    }
    const cv::Mat roi = probMap(cv::Rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1));
    return static_cast<float>(cv::mean(roi)[0]);
}

[[noreturn]] void raise(const std::string& msg) {
    throw std::runtime_error("[DoctrDetectionGGML] " + msg);
}

} // namespace

StepDoctrDetectionGGML::StepDoctrDetectionGGML(const std::string& pathDetector,
                                               int nThreads) {
    ggml_backend_t cpuBackend = ggml_backend_cpu_init();
    if (cpuBackend == nullptr) {
        raise("failed to initialise ggml CPU backend");
    }
    if (nThreads > 0) {
        ggml_backend_cpu_set_n_threads(cpuBackend, nThreads);
    } else if (nThreads == 0) {
        ggml_backend_cpu_set_n_threads(
            cpuBackend,
            std::thread::hardware_concurrency());
    }
    backends_.push_back(cpuBackend);

    std::vector<std::string> labels;
    weights_     = qvac_lib_infer_ggml_classification::graph::loadWeights(
                       pathDetector, backends_, labels);
    computeGraph_ = qvac_lib_infer_ggml_classification::graph::buildGraph(
                       weights_, backends_);

    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
         "[DoctrDetectionGGML] GGML detection model loaded");
}

StepDoctrDetectionGGML::~StepDoctrDetectionGGML() {
    computeGraph_.reset();
    weights_.reset();
    for (ggml_backend_t b : backends_) {
        if (b != nullptr) {
            ggml_backend_free(b);
        }
    }
    backends_.clear();
}

std::tuple<cv::Mat, float, int, int, int, int>
StepDoctrDetectionGGML::preprocessImage(const cv::Mat& img) {
    const int h = img.rows;
    const int w = img.cols;
    const float scale = std::min(
        static_cast<float>(DBNET_INPUT_SIZE) / static_cast<float>(h),
        static_cast<float>(DBNET_INPUT_SIZE) / static_cast<float>(w));
    const int newH = static_cast<int>(static_cast<float>(h) * scale);
    const int newW = static_cast<int>(static_cast<float>(w) * scale);

    cv::Mat resized;
    cv::resize(img, resized, cv::Size(newW, newH), 0, 0, cv::INTER_LINEAR);

    cv::Mat floatImg;
    resized.convertTo(floatImg, CV_32FC3, 1.0 / PIXEL_MAX);

    // Symmetric padding so the image is centred in the canvas.
    const int deltaW  = DBNET_INPUT_SIZE - newW;
    const int deltaH  = DBNET_INPUT_SIZE - newH;
    const int padLeft = (deltaW + 1) / 2;
    const int padTop  = (deltaH + 1) / 2;

    cv::Mat padded = cv::Mat::zeros(DBNET_INPUT_SIZE, DBNET_INPUT_SIZE, CV_32FC3);
    floatImg.copyTo(padded(cv::Rect(padLeft, padTop, newW, newH)));

    cv::subtract(padded, DOCTR_DET_MEAN, padded);
    cv::divide(padded, DOCTR_DET_STD, padded);

    return {padded, scale, newW, newH, padLeft, padTop};
}

cv::Mat StepDoctrDetectionGGML::runInference(const cv::Mat& preprocessed) {
    const int H = preprocessed.rows;
    const int W = preprocessed.cols;
    CV_Assert(H == DBNET_INPUT_SIZE && W == DBNET_INPUT_SIZE);

    // Convert HWC → GGML WHCN (channel-planar, W fastest).
    std::vector<cv::Mat> channels;
    cv::split(preprocessed, channels);

    const int numChannels = static_cast<int>(channels.size());
    std::vector<float> inputData(static_cast<size_t>(numChannels * H * W));
    for (int c = 0; c < numChannels; ++c) {
        CV_Assert(channels[c].isContinuous());
        std::memcpy(
            inputData.data() + static_cast<size_t>(c * H * W),
            channels[c].ptr<float>(),
            static_cast<size_t>(H * W) * sizeof(float));
    }

    ggml_backend_tensor_set(
        computeGraph_.input, inputData.data(), 0,
        inputData.size() * sizeof(float));

    const ggml_status status =
        ggml_backend_graph_compute(backends_[0], computeGraph_.graph);
    if (status != GGML_STATUS_SUCCESS) {
        raise("ggml_backend_graph_compute failed with status " +
              std::to_string(static_cast<int>(status)));
    }

    // The graph outputs raw logits (sigmoid is commented-out in buildGraph).
    // Apply sigmoid here: prob = 1 / (1 + exp(-logit)).
    const size_t nElems = static_cast<size_t>(ggml_nelements(computeGraph_.output_4));
    std::vector<float> logitBuf(nElems);
    ggml_backend_tensor_get(
        computeGraph_.output_4, logitBuf.data(), 0,
        nElems * sizeof(float));

    // GGML WHCN [W=1024, H=1024, C=1, N=1] lays out as [W*y + x] in memory
    // which matches OpenCV row-major [H, W] — direct wrap is safe.
    cv::Mat logitMap(H, W, CV_32F, logitBuf.data());
    cv::Mat expNeg;
    cv::exp(-logitMap, expNeg);
    cv::Mat probMap = 1.0F / (1.0F + expNeg);
    return probMap.clone(); // clone to own the data before logitBuf goes out of scope
}

std::pair<std::vector<std::array<cv::Point2f, 4>>, std::vector<float>>
StepDoctrDetectionGGML::extractPolygons(
    const cv::Mat& probMap, float /*scale*/,
    int /*paddedW*/, int /*paddedH*/,
    int /*padLeft*/, int /*padTop*/,
    int origW, int origH) {
    const int mapH = probMap.rows;
    const int mapW = probMap.cols;

    cv::Mat binary;
    cv::threshold(probMap, binary, BINARIZE_THRESHOLD - 1e-6F, 1.0,
                  cv::THRESH_BINARY);
    binary.convertTo(binary, CV_8U);

    const cv::Mat kernel =
        cv::getStructuringElement(cv::MORPH_RECT, cv::Size(3, 3));
    cv::morphologyEx(binary, binary, cv::MORPH_OPEN, kernel);

    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(binary, contours, cv::RETR_EXTERNAL,
                     cv::CHAIN_APPROX_SIMPLE);

    std::vector<std::array<cv::Point2f, 4>> polygons;
    std::vector<float> confidences;

    for (const auto& contour : contours) {
        const cv::Rect bbox = cv::boundingRect(contour);
        if (bbox.width < MIN_SIZE_BOX || bbox.height < MIN_SIZE_BOX) {
            continue;
        }

        const float score = boxScore(probMap, bbox);
        if (score < BOX_THRESHOLD) {
            continue;
        }

        // Unclip: expand bounding rect by distance = area * ratio / perimeter.
        const double area  = static_cast<double>(bbox.width) * bbox.height;
        const double perim = 2.0 * (bbox.width + bbox.height);
        const double dist  = area * UNCLIP_RATIO / perim;

        float ex0 = static_cast<float>(bbox.x)              - static_cast<float>(dist);
        float ey0 = static_cast<float>(bbox.y)              - static_cast<float>(dist);
        float ex1 = static_cast<float>(bbox.x + bbox.width) + static_cast<float>(dist);
        float ey1 = static_cast<float>(bbox.y + bbox.height)+ static_cast<float>(dist);

        // Normalise to [0, 1] in map space.
        float nx0 = ex0 / static_cast<float>(mapW);
        float ny0 = ey0 / static_cast<float>(mapH);
        float nx1 = ex1 / static_cast<float>(mapW);
        float ny1 = ey1 / static_cast<float>(mapH);

        // Remove symmetric-padding bias (OnnxTR _remove_padding logic).
        if (origH > origW) {
            const float ratio = static_cast<float>(origH) / static_cast<float>(origW);
            nx0 = (nx0 - 0.5F) * ratio + 0.5F;
            nx1 = (nx1 - 0.5F) * ratio + 0.5F;
        } else if (origW > origH) {
            const float ratio = static_cast<float>(origW) / static_cast<float>(origH);
            ny0 = (ny0 - 0.5F) * ratio + 0.5F;
            ny1 = (ny1 - 0.5F) * ratio + 0.5F;
        }

        nx0 = std::clamp(nx0, 0.0F, 1.0F);
        ny0 = std::clamp(ny0, 0.0F, 1.0F);
        nx1 = std::clamp(nx1, 0.0F, 1.0F);
        ny1 = std::clamp(ny1, 0.0F, 1.0F);

        const float x0 = nx0 * static_cast<float>(origW);
        const float y0 = ny0 * static_cast<float>(origH);
        const float x1 = nx1 * static_cast<float>(origW);
        const float y1 = ny1 * static_cast<float>(origH);

        if ((x1 - x0) < 1.0F || (y1 - y0) < 1.0F) {
            continue;
        }

        polygons.push_back({{
            cv::Point2f(x0, y0), cv::Point2f(x1, y0),
            cv::Point2f(x1, y1), cv::Point2f(x0, y1)
        }});
        confidences.push_back(score);
    }

    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::INFO,
         "[DoctrDetectionGGML] extracted " +
             std::to_string(polygons.size()) + " polygons");
    return {polygons, confidences};
}

StepDoctrDetectionGGML::Output
StepDoctrDetectionGGML::process(const Input& input) {
    QLOG(qvac_lib_inference_addon_cpp::logger::Priority::DEBUG,
         "[DoctrDetectionGGML] processing " +
             std::to_string(input.origImg.cols) + "x" +
             std::to_string(input.origImg.rows));

    auto [preprocessed, scale, paddedW, paddedH, padLeft, padTop] =
        preprocessImage(input.origImg);

    cv::Mat probMap = runInference(preprocessed);

    auto [polygons, confidences] = extractPolygons(
        probMap, scale, paddedW, paddedH, padLeft, padTop,
        input.origImg.cols, input.origImg.rows);

    Output output;
    output.context           = input;
    output.polygons          = std::move(polygons);
    output.polygonConfidences = std::move(confidences);
    output.probMap           = probMap;
    output.paddedW           = paddedW;
    output.paddedH           = paddedH;
    output.padLeft           = padLeft;
    output.padTop            = padTop;
    return output;
}

} // namespace doctr::ggml::pipeline
