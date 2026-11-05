#include <algorithm>
#include <any>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <random>
#include <string>
#include <vector>

#include <ggml.h>
#include <gguf.h>
#include <gtest/gtest.h>

#include "model-interface/GgmlBackend.hpp"
#include "model-interface/ImagePreprocessor.hpp"
#include "model-interface/bridgedepth/BridgeDepthGraph.hpp"
#include "model-interface/bridgedepth/BridgeDepthModel.hpp"

namespace bd = classification_ggml::bridgedepth;
using classification_ggml::ImageInput;
using classification_ggml::RawRgbDims;

namespace {

std::vector<uint8_t> readBytes(const std::filesystem::path& path) {
  std::ifstream stream(path, std::ios::binary);
  return {
      std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

std::vector<float> readFloats(const std::filesystem::path& path) {
  const auto bytes = readBytes(path);
  std::vector<float> values(bytes.size() / sizeof(float));
  std::memcpy(values.data(), bytes.data(), values.size() * sizeof(float));
  return values;
}

const std::filesystem::path FIXTURES_DIR = QVAC_TEST_FIXTURES_DIR;

std::string expectThrows(const std::function<void()>& run) {
  try {
    run();
  } catch (const std::exception& error) {
    return error.what();
  }
  ADD_FAILURE() << "expected an exception";
  return {};
}

} // namespace

TEST(BridgeDepthPadding, MatchesInputPadderTopAndRight) {
  const auto pad = bd::computePadding(100, 200, bd::PAD_DIVISOR);
  EXPECT_EQ(pad.top, 12);
  EXPECT_EQ(pad.right, 8);
  const auto none = bd::computePadding(384, 768, bd::PAD_DIVISOR);
  EXPECT_EQ(none.top, 0);
  EXPECT_EQ(none.right, 0);

  // 1 channel worth of a 2x3 image, repeated over 3 channels.
  std::vector<float> chw;
  for (int c = 0; c < 3; ++c)
    for (int i = 0; i < 6; ++i)
      chw.push_back(static_cast<float>(c * 10 + i));
  const auto padded = bd::padImage(chw.data(), 2, 3, {1, 2});
  ASSERT_EQ(padded.size(), 3U * 3 * 5);
  // Top row replicates row 0, the right columns replicate column 2.
  const std::vector<float> expected = {
      0, 1, 2, 2, 2, 0, 1, 2, 2, 2, 3, 4, 5, 5, 5};
  for (size_t i = 0; i < expected.size(); ++i)
    EXPECT_EQ(padded[i], expected[i]) << i;
  EXPECT_EQ(padded[15], 10.0F);
}

TEST(BridgeDepthInput, RawRgbBecomesPlanar) {
  ImageInput image;
  image.rawRgb = RawRgbDims{32, 32, 3};
  image.data.resize(32 * 32 * 3);
  for (size_t i = 0; i < image.data.size(); ++i)
    image.data[i] =
        static_cast<uint8_t>(i % 3 == 0 ? 10 : (i % 3 == 1 ? 20 : 30));
  uint32_t width = 0;
  uint32_t height = 0;
  const auto chw = bd::toPlanarRgb(image, width, height);
  EXPECT_EQ(width, 32U);
  EXPECT_EQ(height, 32U);
  ASSERT_EQ(chw.size(), 32U * 32 * 3);
  EXPECT_EQ(chw[0], 10.0F);
  EXPECT_EQ(chw[32 * 32], 20.0F);
  EXPECT_EQ(chw[2 * 32 * 32 + 5], 30.0F);
}

TEST(BridgeDepthInput, RejectsSizesOutsideTheSupportedRange) {
  uint32_t width = 0;
  uint32_t height = 0;
  ImageInput small;
  small.rawRgb = RawRgbDims{31, 64, 3};
  small.data.resize(31 * 64 * 3);
  EXPECT_NE(
      expectThrows([&] {
        bd::toPlanarRgb(small, width, height);
      }).find("at least 32"),
      std::string::npos);
  ImageInput large;
  large.rawRgb = RawRgbDims{bd::MAX_SIDE + 1, 32, 3};
  large.data.resize(static_cast<size_t>(bd::MAX_SIDE + 1) * 32 * 3);
  EXPECT_NE(
      expectThrows([&] {
        bd::toPlanarRgb(large, width, height);
      }).find("at most"),
      std::string::npos);
  // 1080p pads to 1088 rows: 136 * 240 = 32640 cells, the largest common
  // size under the limit. 2048x1088 is 34816 and aborts on Metal.
  EXPECT_EQ(bd::gridCells(1920, 1080), 32640);
  ImageInput fullHd;
  fullHd.rawRgb = RawRgbDims{1920, 1080, 3};
  fullHd.data.resize(static_cast<size_t>(1920) * 1080 * 3);
  EXPECT_EQ(
      bd::toPlanarRgb(fullHd, width, height).size(),
      static_cast<size_t>(1920) * 1080 * 3);
  ImageInput wide;
  wide.rawRgb = RawRgbDims{2048, 1088, 3};
  wide.data.resize(static_cast<size_t>(2048) * 1088 * 3);
  EXPECT_NE(
      expectThrows([&] {
        bd::toPlanarRgb(wide, width, height);
      }).find("too large"),
      std::string::npos);
  // A PNG signature, an IHDR claiming 4096x4096 and an empty IDAT, which is
  // enough for stbi_info but not for a decode. The size error proves the
  // header is checked before the full decode.
  ImageInput hugePng;
  hugePng.data = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0,    13,
                  'I',  'H', 'D', 'R', 0,    0,    0x10, 0,    0, 0, 0x10, 0,
                  8,    2,   0,   0,   0,    0,    0,    0,    0, 0, 0,    0,
                  0,    'I', 'D', 'A', 'T',  0,    0,    0,    0};
  const std::string hugeError =
      expectThrows([&] { bd::toPlanarRgb(hugePng, width, height); });
  EXPECT_NE(hugeError.find("at most"), std::string::npos) << hugeError;
  ImageInput garbage;
  garbage.data = {1, 2, 3, 4};
  EXPECT_NE(
      expectThrows([&] {
        bd::toPlanarRgb(garbage, width, height);
      }).find("JPEG/PNG"),
      std::string::npos);
}

TEST(BridgeDepthModel, RejectsInvalidConfigurationAndUnloadedInference) {
  bd::BridgeDepthModel noPath({"", "", "CPU"});
  EXPECT_NE(
      expectThrows([&] { noPath.load(); }).find("modelPath is required"),
      std::string::npos);
  bd::BridgeDepthModel badThreads({"model.gguf", "", "CPU", 0});
  EXPECT_NE(
      expectThrows([&] { badThreads.load(); }).find("threads"),
      std::string::npos);
  bd::BridgeDepthModel unloaded({"model.gguf", "", "CPU"});
  EXPECT_NE(
      expectThrows([&] {
        unloaded.process(std::any(bd::StereoInput{}));
      }).find("not loaded"),
      std::string::npos);
  EXPECT_NE(
      expectThrows([&] {
        unloaded.process(std::any(ImageInput{}));
      }).find("invalid stereo input"),
      std::string::npos);
}

namespace {
class BridgeDepthGgufTest : public ::testing::Test {
protected:
  std::filesystem::path directory_;
  std::filesystem::path path_;

  void SetUp() override {
    directory_ = std::filesystem::temp_directory_path() /
                 ("qvac-bridgedepth-" + std::to_string(std::random_device{}()));
    ASSERT_TRUE(std::filesystem::create_directory(directory_));
    path_ = directory_ / "invalid.gguf";
  }

  void TearDown() override { std::filesystem::remove_all(directory_); }

  // A metadata-complete file whose single tensor does not match the layout.
  // supportedKv writes the converter's hyperparameters, otherwise all are 4.
  void
  write(const char* architecture, bool withMetadata, bool supportedKv = false) {
    std::unique_ptr<ggml_context, decltype(&ggml_free)> context(
        ggml_init({1024 * 1024, nullptr, false}), ggml_free);
    std::unique_ptr<gguf_context, decltype(&gguf_free)> file(
        gguf_init_empty(), gguf_free);
    gguf_set_val_str(file.get(), "general.architecture", architecture);
    if (withMetadata) {
      const uint32_t supported[] = {
          12, 6, 37, 40, 4, 2, 4, 5, 4, 6, 5, 4, 5, 128};
      int index = 0;
      for (const char* key :
           {"bridgedepth.mono.depth",
            "bridgedepth.mono.n_heads",
            "bridgedepth.mono.pos_grid",
            "bridgedepth.dpn.num_disp",
            "bridgedepth.dpn.cost_group",
            "bridgedepth.dpn.num_proposals",
            "bridgedepth.nmp.prop_n_heads",
            "bridgedepth.nmp.num_prop_layers",
            "bridgedepth.nmp.infer_n_heads",
            "bridgedepth.nmp.window_size",
            "bridgedepth.nmp.num_infer_layers",
            "bridgedepth.nmp.refine_window_size",
            "bridgedepth.nmp.num_refine_layers",
            "bridgedepth.backbone.out_channels"})
        gguf_set_val_u32(file.get(), key, supportedKv ? supported[index++] : 4);
      const int32_t layers[] = {2, 5, 8, 11};
      gguf_set_arr_data(
          file.get(),
          "bridgedepth.mono.intermediate_layers",
          GGUF_TYPE_INT32,
          layers,
          4);
    }
    auto* tensor = ggml_new_tensor_1d(context.get(), GGML_TYPE_F32, 4);
    ggml_set_zero(tensor);
    ggml_set_name(tensor, "mono.pretrained.pos_embed");
    gguf_add_tensor(file.get(), tensor);
    ASSERT_TRUE(gguf_write_to_file(file.get(), path_.string().c_str(), false));
  }

  std::string loadError() {
    bd::BridgeDepthModel model({path_.string(), "", "CPU", 2});
    return expectThrows([&] { model.load(); });
  }
};
} // namespace

TEST_F(BridgeDepthGgufTest, RejectsWrongArchitecture) {
  write("megaloc", true);
  EXPECT_NE(loadError().find("expected bridgedepth"), std::string::npos);
}

TEST_F(BridgeDepthGgufTest, RejectsMissingMetadata) {
  write("bridgedepth", false);
  EXPECT_NE(loadError().find("missing or non-u32 kv"), std::string::npos);
}

TEST_F(BridgeDepthGgufTest, RejectsUnsupportedHyperparameters) {
  write("bridgedepth", true);
  EXPECT_NE(loadError().find("unsupported hyperparameters"), std::string::npos);
}

TEST_F(BridgeDepthGgufTest, RejectsForeignTensorLayout) {
  write("bridgedepth", true, true);
  EXPECT_NE(loadError().find("unsupported GGUF layout"), std::string::npos);
}

TEST_F(BridgeDepthGgufTest, RejectsMissingFile) {
  EXPECT_NE(loadError().find("cannot open"), std::string::npos);
}

// Needs the converted weights (docs/bridgedepth.md); set
// QVAC_BRIDGEDEPTH_MODEL_PATH. QVAC_BRIDGEDEPTH_BACKEND picks the device
// (default CPU). Fixture: test/fixtures/generate-bridgedepth-reference.py.
class BridgeDepthReference : public ::testing::Test {
protected:
  void SetUp() override {
    const char* path = std::getenv("QVAC_BRIDGEDEPTH_MODEL_PATH");
    if (path == nullptr || *path == '\0')
      GTEST_SKIP() << "QVAC_BRIDGEDEPTH_MODEL_PATH is not set";
    modelPath_ = path;
    const char* backend = std::getenv("QVAC_BRIDGEDEPTH_BACKEND");
    backend_ = backend != nullptr && *backend != '\0' ? backend : "CPU";
    for (const char* name : {"left", "right"}) {
      ImageInput image;
      image.data = readBytes(
          FIXTURES_DIR / (std::string("bridgedepth-") + name + ".png"));
      ASSERT_FALSE(image.data.empty()) << name;
      (std::string(name) == "left" ? pair_.left : pair_.right) =
          std::move(image);
    }
    reference_ = readFloats(FIXTURES_DIR / "bridgedepth-disparity-f32.bin");
    seeds_ = readFloats(FIXTURES_DIR / "bridgedepth-seeds-f32.bin");
    ASSERT_EQ(reference_.size(), 100U * 200);
    ASSERT_EQ(seeds_.size(), 14U * 26 * 2);
  }

  double within(const std::vector<float>& got, double tolerance) const {
    size_t count = 0;
    for (size_t i = 0; i < got.size(); ++i)
      count += std::fabs(got[i] - reference_[i]) < tolerance ? 1 : 0;
    return static_cast<double>(count) / static_cast<double>(got.size());
  }

  std::string modelPath_;
  std::string backend_;
  bd::StereoInput pair_;
  std::vector<float> reference_;
  std::vector<float> seeds_;
};

// Torch and ggml break top-k ties in the DPN differently; feeding the
// reference seeds isolates every other op. Measured 2026-11-04: CPU 99.99%
// within 0.05 px (M5 Pro and x86), CUDA 99.93% (T4), Metal 99.75% (M5 Pro),
// Vulkan 99.63% (T4). Metal and Vulkan stage F32 matmul operands as half in
// shared memory (Vulkan when the device has fp16 or coopmat2), so their gate
// is 99% within 0.2 px; both measure 99.8% or more there.
TEST_F(BridgeDepthReference, MatchesTorchWithReferenceSeeds) {
  classification_ggml::GgmlBackends backends(backend_, "", 4, "test");
  bd::BridgeDepthGraph graph(modelPath_, backends.device(), backends.cpu());
  uint32_t width = 0;
  uint32_t height = 0;
  const auto left = bd::toPlanarRgb(pair_.left, width, height);
  const auto right = bd::toPlanarRgb(pair_.right, width, height);
  ASSERT_EQ(width, 200U);
  ASSERT_EQ(height, 100U);
  const auto disparity =
      graph.infer(left.data(), right.data(), 100, 200, &seeds_);
  ASSERT_EQ(disparity.size(), reference_.size());
  const int deviceId =
      classification_ggml::backendId(ggml_backend_name(backends.device()));
  const bool halfGemm = deviceId == 1 || deviceId == 3;
  std::printf(
      "%s reference seeds: %.5f within 0.05 px, %.5f within 0.2 px\n",
      ggml_backend_name(backends.device()),
      within(disparity, 0.05),
      within(disparity, 0.2));
  if (halfGemm) {
    EXPECT_GE(within(disparity, 0.2), 0.99);
  } else {
    EXPECT_GE(within(disparity, 0.05), 0.999);
  }
  // A GPU op that falls back to the CPU keeps parity and only costs speed.
  // OpenCL lacks ops this graph needs and is left out.
  if (deviceId == 1 || deviceId == 2 || deviceId == 3) {
    EXPECT_EQ(graph.cpuFallbackNodes(), 0);
  }
}

// The production path: decode, own top-k seeds, unpad. Measured 2026-11-03:
// 99.8% within 0.2 px on CPU, Metal, CUDA and Vulkan; the misses follow top-k
// tie breaks.
TEST_F(BridgeDepthReference, ModelMatchesTorchWithOwnSeeds) {
  bd::BridgeDepthModel model({modelPath_, "", backend_, 4});
  model.load();
  const auto output =
      std::any_cast<bd::DisparityOutput>(model.process(std::any(pair_)));
  EXPECT_EQ(output.width, 200U);
  EXPECT_EQ(output.height, 100U);
  ASSERT_EQ(output.disparity.size(), reference_.size());
  std::printf(
      "%s own seeds: %.5f within 0.2 px\n",
      backend_.c_str(),
      within(output.disparity, 0.2));
  EXPECT_GE(within(output.disparity, 0.2), 0.99);

  bool sawWeights = false;
  for (const auto& [key, value] : model.runtimeStats()) {
    if (key == "weight_bytes") {
      sawWeights = true;
      EXPECT_GT(std::get<int64_t>(value), 100'000'000);
    }
  }
  EXPECT_TRUE(sawWeights);

  bd::StereoInput mismatched = pair_;
  mismatched.right.rawRgb = RawRgbDims{64, 64, 3};
  mismatched.right.data.assign(64 * 64 * 3, 128);
  EXPECT_NE(
      expectThrows([&] {
        model.process(std::any(mismatched));
      }).find("same size"),
      std::string::npos);
}

// Repeated calls, a size change in between (the positional embedding is cached
// per size) and switching the seeds override must not leak state between runs.
TEST_F(BridgeDepthReference, RepeatedAndMixedSizesGiveTheSameResult) {
  classification_ggml::GgmlBackends backends(backend_, "", 4, "test");
  bd::BridgeDepthGraph graph(modelPath_, backends.device(), backends.cpu());
  uint32_t width = 0;
  uint32_t height = 0;
  const auto left = bd::toPlanarRgb(pair_.left, width, height);
  const auto right = bd::toPlanarRgb(pair_.right, width, height);
  auto maxDiff = [](const std::vector<float>& a, const std::vector<float>& b) {
    float max = 0.0f;
    for (size_t i = 0; i < a.size(); ++i)
      max = std::max(max, std::fabs(a[i] - b[i]));
    return max;
  };
  const auto first = graph.infer(left.data(), right.data(), 100, 200, &seeds_);
  const auto again = graph.infer(left.data(), right.data(), 100, 200, &seeds_);
  EXPECT_LT(maxDiff(first, again), 1e-4f);

  const auto own = graph.infer(left.data(), right.data(), 100, 200);
  EXPECT_GE(within(own, 0.2), 0.99);

  // 33 x 47 pads by 15 rows and 1 column, the largest top pad.
  std::vector<float> small(3U * 33 * 47);
  for (size_t i = 0; i < small.size(); ++i)
    small[i] = static_cast<float>((i * 37) % 256);
  const auto other = graph.infer(small.data(), small.data(), 33, 47);
  ASSERT_EQ(other.size(), 33U * 47);
  for (const float value : other)
    ASSERT_TRUE(std::isfinite(value));

  const auto last = graph.infer(left.data(), right.data(), 100, 200, &seeds_);
  EXPECT_LT(maxDiff(first, last), 1e-4f);
}

// An index outside the rpe table would make GPU get_rows read past it, and the
// layout fingerprint does not cover tensor data, so load checks every value.
TEST_F(BridgeDepthReference, RejectsOutOfRangeRpeIndex) {
  const auto copy =
      std::filesystem::temp_directory_path() /
      ("qvac-bridgedepth-" + std::to_string(std::random_device{}()) + ".gguf");
  std::filesystem::copy_file(modelPath_, copy);
  struct Remove {
    std::filesystem::path path;
    ~Remove() { std::filesystem::remove(path); }
  } cleanup{copy};
  {
    gguf_init_params params{};
    params.no_alloc = true;
    gguf_context* gguf = gguf_init_from_file(modelPath_.c_str(), params);
    ASSERT_NE(gguf, nullptr);
    const int64_t id = gguf_find_tensor(
        gguf, "align_0.layers.0.attn.nmp.attn.relative_position_index");
    ASSERT_GE(id, 0);
    const auto offset = static_cast<std::streamoff>(
        gguf_get_data_offset(gguf) + gguf_get_tensor_offset(gguf, id));
    gguf_free(gguf);
    std::fstream file(copy, std::ios::binary | std::ios::in | std::ios::out);
    file.seekp(offset);
    const int32_t outside = 100000;
    file.write(reinterpret_cast<const char*>(&outside), sizeof(outside));
    ASSERT_TRUE(file.good());
  }
  classification_ggml::GgmlBackends backends("CPU", "", 2, "test");
  EXPECT_NE(
      expectThrows([&] {
        bd::BridgeDepthGraph graph(
            copy.string(), backends.device(), backends.cpu());
      }).find("has an index outside"),
      std::string::npos);
}
