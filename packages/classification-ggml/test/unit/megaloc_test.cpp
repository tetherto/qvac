#include <cmath>
#include <filesystem>
#include <fstream>
#include <random>
#include <utility>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "../fixtures/megaloc-preprocess.hpp"
#include "model-interface/ImagePreprocessor.hpp"
#include "model-interface/megaloc/MegaLocModel.hpp"

namespace mega = classification_ggml::megaloc;

TEST(MegaLocBackendNames, MatchesFabricDeviceNamesAndPublicIds) {
  for (const auto& [name, expected] :
       {std::pair{"CPU", 0},
        {"Metal", 1},
        {"Metal0", 1},
        {"MTL0", 1},
        {"CUDA0", 2},
        {"Vulkan1", 3},
        {"OpenCL", 4},
        {"GPUOpenCL", 4},
        {"unknown", 99}}) {
    EXPECT_EQ(mega::backendId(name), expected) << name;
  }
}

namespace {
class MegaLocGgufTest : public ::testing::Test {
protected:
  std::filesystem::path directory_;
  std::filesystem::path path_;
  std::unique_ptr<ggml_context, decltype(&ggml_free)> context_{
      nullptr, ggml_free};
  std::unique_ptr<gguf_context, decltype(&gguf_free)> file_{nullptr, gguf_free};

  void SetUp() override {
    directory_ = std::filesystem::temp_directory_path() /
                 ("qvac-megaloc-" + std::to_string(std::random_device{}()));
    ASSERT_TRUE(std::filesystem::create_directory(directory_));
    path_ = directory_ / "invalid.gguf";
    context_.reset(ggml_init({4 * 1024 * 1024, nullptr, false}));
    ASSERT_NE(context_, nullptr);
    file_.reset(gguf_init_empty());
    gguf_set_val_str(file_.get(), "general.architecture", "megaloc");
    gguf_set_val_u32(file_.get(), "megaloc.image_size", 322);
    gguf_set_val_u32(file_.get(), "megaloc.descriptor_length", 8448);
  }

  void tensor(const char* name, ggml_type type, int64_t width, int64_t height) {
    auto* value = ggml_new_tensor_2d(context_.get(), type, width, height);
    ggml_set_zero(value);
    ggml_set_name(value, name);
    gguf_add_tensor(file_.get(), value);
  }

  void expectRejected(const std::string& reason) {
    ASSERT_TRUE(gguf_write_to_file(file_.get(), path_.string().c_str(), false));
    mega::MegaLocModel model({path_.string(), "", "CPU"});
    try {
      model.load();
      FAIL() << "Malformed GGUF was accepted";
    } catch (const std::exception& error) {
      EXPECT_NE(std::string(error.what()).find(reason), std::string::npos)
          << error.what();
    }
  }

  void TearDown() override {
    file_.reset();
    context_.reset();
    std::filesystem::remove(path_);
    std::filesystem::remove(directory_);
  }
};
} // namespace

TEST_F(MegaLocGgufTest, RejectsBf16Projection) {
  tensor("aggregator.linear.weight", GGML_TYPE_BF16, 256, 1);
  expectRejected("only F16");
}

TEST_F(MegaLocGgufTest, RejectsWrongPositionShape) {
  tensor("aggregator.linear.weight", GGML_TYPE_F16, 256, 1);
  tensor("megaloc.pos_embed", GGML_TYPE_F32, 768, 529);
  expectRejected("wrong shape");
}

TEST_F(MegaLocGgufTest, RejectsMissingBodyTensor) {
  tensor("aggregator.linear.weight", GGML_TYPE_F16, 256, 1);
  tensor("megaloc.pos_embed", GGML_TYPE_F32, 768, 530);
  expectRejected("missing tensor backbone.cls_token");
}

TEST_F(MegaLocGgufTest, RejectsWrongMetadataType) {
  gguf_set_val_str(file_.get(), "megaloc.image_size", "322");
  expectRejected("unsupported megaloc.image_size");
}

TEST(MegaLocPreprocessor, MatchesOriginalPyTorchResizeAndUnfold) {
  for (const auto& reference : MEGALOC_PREPROCESS_REFERENCE) {
    classification_ggml::ImageInput input;
    input.data.resize(
        static_cast<size_t>(reference.width) * reference.height * 3);
    for (size_t i = 0; i < input.data.size(); ++i)
      input.data[i] = static_cast<uint8_t>((i * 37 + i / 19) % 256);
    input.rawRgb = classification_ggml::RawRgbDims{
        static_cast<uint32_t>(reference.width),
        static_cast<uint32_t>(reference.height),
        3};
    const auto patches = mega::preprocess(input);
    for (size_t i = 0; i < MEGALOC_SAMPLE_INDICES.size(); ++i) {
      EXPECT_NEAR(
          patches[MEGALOC_SAMPLE_INDICES[i]], reference.values[i], 2e-5F)
          << reference.width << "x" << reference.height << " sample " << i;
    }
  }
}

TEST(MegaLocPreprocessor, ConstantRgbRetainsNormalizationAndPatchLayout) {
  classification_ggml::ImageInput input;
  input.data.resize(17 * 9 * 3);
  for (size_t i = 0; i < input.data.size(); i += 3) {
    input.data[i] = 32;
    input.data[i + 1] = 128;
    input.data[i + 2] = 240;
  }
  input.rawRgb = classification_ggml::RawRgbDims{17, 9, 3};
  const auto patches = mega::preprocess(input);
  ASSERT_EQ(
      patches.size(),
      static_cast<size_t>(mega::PATCH_COUNT) * mega::PATCH_WIDTH);
  for (size_t i = 0; i < patches.size(); ++i) {
    const auto channel =
        (i % mega::PATCH_WIDTH) / (mega::PATCH_SIZE * mega::PATCH_SIZE);
    const float pixel = static_cast<float>(input.data[channel]) / 255.0F;
    EXPECT_NEAR(
        patches[i],
        (pixel - classification_ggml::preprocess::IMAGENET_MEAN[channel]) /
            classification_ggml::preprocess::IMAGENET_STD[channel],
        2e-6F);
  }
}

TEST(MegaLocPreprocessor, RejectsInvalidImagesAndShapes) {
  classification_ggml::ImageInput input;
  EXPECT_THROW(mega::preprocess(input), std::exception);
  input.data.resize(12);
  input.rawRgb = classification_ggml::RawRgbDims{2, 2, 4};
  EXPECT_THROW(mega::preprocess(input), std::exception);
  input.rawRgb = classification_ggml::RawRgbDims{2, 3, 3};
  EXPECT_THROW(mega::preprocess(input), std::exception);
  input.rawRgb = classification_ggml::RawRgbDims{16385, 1, 3};
  EXPECT_THROW(mega::preprocess(input), std::exception);
}

TEST(MegaLocModel, RejectsInvalidConfigurationAndUnloadedInference) {
  mega::MegaLocModel invalid({"", "", "CPU"});
  EXPECT_THROW(invalid.load(), std::exception);
  EXPECT_THROW(
      invalid.process(classification_ggml::ImageInput{}), std::exception);
  EXPECT_THROW(invalid.process(42), std::exception);
  mega::Config config{"missing.gguf", "", "CPU", 0};
  mega::MegaLocModel invalidThreads(config);
  EXPECT_THROW(invalidThreads.load(), std::exception);
}

TEST(MegaLocModel, RejectsWrongArchitectureBeforeGraphBuild) {
  const auto path =
      std::filesystem::temp_directory_path() / "qvac-megaloc-invalid.gguf";
  auto* gguf = gguf_init_empty();
  gguf_set_val_str(gguf, "general.architecture", "mobilenet");
  ASSERT_TRUE(gguf_write_to_file(gguf, path.string().c_str(), true));
  gguf_free(gguf);
  mega::MegaLocModel model({path.string(), "", "CPU"});
  EXPECT_THROW(model.load(), std::exception);
  std::filesystem::remove(path);
}
