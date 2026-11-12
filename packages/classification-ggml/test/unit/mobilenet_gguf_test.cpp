// The MobileNet loader rejects a malformed GGUF with InvalidArgument instead
// of tripping a GGML_ASSERT, which aborts the process. Each test writes a
// MobileNet-shaped file with zero weights, built from the compiled-in config,
// breaks one thing and expects both the load and the metadata-only
// measurement to reject it.

#include <cstdint>
#include <filesystem>
#include <functional>
#include <initializer_list>
#include <memory>
#include <random>
#include <string>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/ModelFootprint.hpp"
#include "model-interface/mobilenet/ClassificationModel.hpp"
#include "model-interface/mobilenet/MobileNetGraph.hpp"

namespace qcc = classification_ggml;
namespace qgraph = classification_ggml::graph;

namespace {

// Room for every weight of the model as F16 (about 4.3 MB) plus tensor
// metadata.
constexpr size_t WEIGHT_CONTEXT_BYTES = size_t{16} * 1024 * 1024;

class MobileNetGgufTest : public ::testing::Test {
protected:
  std::filesystem::path directory_;
  std::filesystem::path path_;
  std::unique_ptr<ggml_context, decltype(&ggml_free)> context_{
      nullptr, ggml_free};
  std::unique_ptr<gguf_context, decltype(&gguf_free)> file_{nullptr, gguf_free};
  // Tensor whose outermost dimension is written one larger than the config.
  std::string wrongShape_;

  void SetUp() override {
    // The binary runs from the build tree, so the files stay out of the
    // source tree and out of the system temp directory.
    directory_ =
        std::filesystem::current_path() /
        ("qvac-mobilenet-gguf-" + std::to_string(std::random_device{}()));
    ASSERT_TRUE(std::filesystem::create_directory(directory_));
    path_ = directory_ / "mobilenet.gguf";
    context_.reset(ggml_init({WEIGHT_CONTEXT_BYTES, nullptr, false}));
    ASSERT_NE(context_, nullptr);
    file_.reset(gguf_init_empty());
    gguf_set_val_str(file_.get(), "general.architecture", "mobilenetv3-small");
  }

  void TearDown() override {
    file_.reset();
    context_.reset();
    std::error_code error;
    std::filesystem::remove_all(directory_, error);
  }

  void tensor(const std::string& name, std::initializer_list<int64_t> shape) {
    int64_t ne[GGML_MAX_DIMS] = {1, 1, 1, 1};
    int dims = 0;
    for (const int64_t dimension : shape)
      ne[dims++] = dimension;
    if (name == wrongShape_)
      ne[dims - 1] += 1;
    auto* value = ggml_new_tensor(context_.get(), GGML_TYPE_F16, dims, ne);
    ggml_set_zero(value);
    ggml_set_name(value, name.c_str());
    gguf_add_tensor(file_.get(), value);
  }

  void batchNorm(const std::string& prefix, int channels) {
    for (const char* param : {"weight", "bias", "running_mean", "running_var"})
      tensor(prefix + "." + param, {channels});
  }

  // Every tensor the loader reads, in the shapes MobileNetGraph expects.
  void writeModel() {
    constexpr int pointwise = qgraph::POINTWISE_KERNEL;
    tensor(
        "features.0.0.weight",
        {qgraph::STEM_KERNEL,
         qgraph::STEM_KERNEL,
         qgraph::INPUT_CHANNELS,
         qgraph::STEM_OUT_CHANNELS});
    batchNorm("features.0.1", qgraph::STEM_OUT_CHANNELS);
    for (const qgraph::BlockConfig& cfg : qgraph::BLOCKS) {
      const std::string base =
          "features." + std::to_string(cfg.featuresIndex) + ".block.";
      int index = 0;
      if (cfg.expandedChannels != cfg.inputChannels) {
        tensor(
            base + "0.0.weight",
            {pointwise, pointwise, cfg.inputChannels, cfg.expandedChannels});
        batchNorm(base + "0.1", cfg.expandedChannels);
        index = 1;
      }
      const std::string dw = base + std::to_string(index++);
      tensor(
          dw + ".0.weight",
          {cfg.depthwiseKernel, cfg.depthwiseKernel, 1, cfg.expandedChannels});
      batchNorm(dw + ".1", cfg.expandedChannels);
      if (cfg.useSe) {
        const std::string se = base + std::to_string(index++);
        tensor(
            se + ".fc1.weight",
            {pointwise,
             pointwise,
             cfg.expandedChannels,
             cfg.seReducedChannels});
        tensor(se + ".fc1.bias", {cfg.seReducedChannels});
        tensor(
            se + ".fc2.weight",
            {pointwise,
             pointwise,
             cfg.seReducedChannels,
             cfg.expandedChannels});
        tensor(se + ".fc2.bias", {cfg.expandedChannels});
      }
      const std::string projection = base + std::to_string(index);
      tensor(
          projection + ".0.weight",
          {pointwise, pointwise, cfg.expandedChannels, cfg.outputChannels});
      batchNorm(projection + ".1", cfg.outputChannels);
    }
    tensor(
        "features.12.0.weight",
        {pointwise,
         pointwise,
         qgraph::BLOCKS.back().outputChannels,
         qgraph::TAIL_OUT_CHANNELS});
    batchNorm("features.12.1", qgraph::TAIL_OUT_CHANNELS);
    tensor(
        "classifier.0.weight",
        {qgraph::TAIL_OUT_CHANNELS, qgraph::CLASSIFIER_HIDDEN});
    tensor("classifier.0.bias", {qgraph::CLASSIFIER_HIDDEN});
    tensor(
        "classifier.3.weight",
        {qgraph::CLASSIFIER_HIDDEN, qgraph::NUM_CLASSES});
    tensor("classifier.3.bias", {qgraph::NUM_CLASSES});
    ASSERT_TRUE(gguf_write_to_file(file_.get(), path_.string().c_str(), false));
  }

  static void expectInvalid(const std::function<void()>& call) {
    try {
      call();
      FAIL() << "Malformed MobileNet GGUF was accepted";
    } catch (const qvac_errors::StatusError& error) {
      EXPECT_NE(error.codeString().find("InvalidArgument"), std::string::npos)
          << error.codeString() << " " << error.what();
    }
  }

  void expectRejected() {
    expectInvalid([&] {
      qcc::ClassificationModel model(path_.string());
      model.load();
    });
    expectInvalid([&] { qcc::measureFootprint(path_.string(), "", "", 0, 0); });
  }
};

} // namespace

TEST_F(MobileNetGgufTest, WellFormedFileIsMeasured) {
  writeModel();
  const auto measured = qcc::measureFootprint(path_.string(), "", "", 0, 0);
  EXPECT_EQ(measured.kind, qcc::ModelKind::MobileNet);
  EXPECT_GT(measured.hostWeightBytes, 0U);
}

TEST_F(MobileNetGgufTest, RejectsAWeightShapeThatDiffersFromTheConfig) {
  // A 5x5 depthwise kernel in the middle of the network.
  wrongShape_ = "features.5.block.1.0.weight";
  writeModel();
  expectRejected();
}

TEST_F(MobileNetGgufTest, RejectsAClassifierShapeThatDiffersFromTheConfig) {
  wrongShape_ = "classifier.0.weight";
  writeModel();
  expectRejected();
}

TEST_F(MobileNetGgufTest, RejectsAMetadataValueOfTheWrongType) {
  gguf_set_val_str(file_.get(), "mobilenet.num_classes", "3");
  writeModel();
  expectRejected();
}

TEST_F(MobileNetGgufTest, RejectsTensorDataPastTheEndOfTheFile) {
  writeModel();
  // gguf pads every tensor's data to the alignment, so dropping a few bytes
  // would only cut padding. Half the file cuts into the weights while the
  // header and tensor table, a few KB, stay whole.
  std::filesystem::resize_file(path_, std::filesystem::file_size(path_) / 2);
  expectRejected();
}
