// measureFootprint reads GGUF metadata only. These tests load each model for
// real, run one inference and require the measured sizes to equal the buffers
// the loaded model holds, byte for byte.
//
// Models: MobileNet from weights/ or QVAC_CLASSIFICATION_MODEL_PATH, MegaLoc
// from QVAC_MEGALOC_F16_MODEL_PATH and QVAC_MEGALOC_MIXED_MODEL_PATH,
// BridgeDepth from QVAC_BRIDGEDEPTH_MODEL_PATH; a test without its model is
// skipped. QVAC_FOOTPRINT_BACKEND picks the device (default CPU).

#include <any>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

#include <ggml-alloc.h>
#include <ggml.h>
#include <gtest/gtest.h>
#if !defined(_WIN32)
#include <sys/resource.h>
#endif

#include "model-interface/GgmlBackend.hpp"
#include "model-interface/ModelFit.hpp"
#include "model-interface/ModelFootprint.hpp"
#include "model-interface/bridgedepth/BridgeDepthGraph.hpp"
#include "model-interface/bridgedepth/BridgeDepthModel.hpp"
#include "model-interface/megaloc/MegaLocModel.hpp"
#include "model-interface/mobilenet/ClassificationModel.hpp"

namespace qcc = classification_ggml;
namespace bd = classification_ggml::bridgedepth;
namespace mega = classification_ggml::megaloc;

namespace {

constexpr int TEST_THREADS = 4;
// The committed stereo fixture size, and the size assessFit assumes when the
// request names none.
constexpr uint32_t FIXTURE_WIDTH = 200;
constexpr uint32_t FIXTURE_HEIGHT = 100;
constexpr auto HD_WIDTH =
    static_cast<uint32_t>(classification_ggml::fit::DEFAULT_FIT_WIDTH);
constexpr auto HD_HEIGHT =
    static_cast<uint32_t>(classification_ggml::fit::DEFAULT_FIT_HEIGHT);
// A 16:9 size above the box, downsampled to exactly HD_WIDTH x HD_HEIGHT.
constexpr uint32_t FULL_HD_WIDTH = 1920;
constexpr uint32_t FULL_HD_HEIGHT = 1080;
constexpr uint32_t RGB_CHANNELS = 3;

std::string envOr(const char* name, const std::string& fallback) {
  const char* value = std::getenv(name);
  return value != nullptr && *value != '\0' ? value : fallback;
}

std::string backendName() { return envOr("QVAC_FOOTPRINT_BACKEND", "CPU"); }

std::string mobileNetPath() {
  const std::string env = envOr("QVAC_CLASSIFICATION_MODEL_PATH", "");
  if (!env.empty() && std::filesystem::exists(env))
    return env;
  // The binary runs from build/test/unit; weights/ is in the package root.
  constexpr int maxParents = 6;
  std::filesystem::path here = std::filesystem::current_path();
  for (int i = 0; i < maxParents; ++i) {
    const auto candidate = here / "weights" / "mobilenetv3_3class_v3_fp16.gguf";
    if (std::filesystem::exists(candidate))
      return candidate.string();
    if (!here.has_parent_path())
      break;
    here = here.parent_path();
  }
  return "";
}

// Deterministic, non-constant pixels; the values do not matter for sizes.
qcc::ImageInput syntheticRgb(uint32_t width, uint32_t height, uint32_t shift) {
  constexpr uint32_t byteRange = 256;
  qcc::ImageInput image;
  image.data.resize(static_cast<size_t>(width) * height * RGB_CHANNELS);
  for (uint32_t y = 0; y < height; ++y) {
    for (uint32_t x = 0; x < width; ++x) {
      for (uint32_t c = 0; c < RGB_CHANNELS; ++c)
        image.data[(static_cast<size_t>(y) * width + x) * RGB_CHANNELS + c] =
            static_cast<uint8_t>(((x + shift) * (c + 2) + y * 3) % byteRange);
    }
  }
  image.rawRgb = qcc::RawRgbDims{width, height, RGB_CHANNELS};
  return image;
}

void expectEqual(
    const std::string& label, const qcc::ModelFootprint& measured,
    const qcc::BufferFootprint& real) {
  std::printf(
      "FOOTPRINT %-22s %-5s weight %llu/%llu deviceCompute %llu/%llu "
      "cpuCompute %llu/%llu cpuWork %llu/%llu staging %llu "
      "(measured/real)\n",
      label.c_str(),
      measured.deviceName.c_str(),
      static_cast<unsigned long long>(
          measured.deviceWeightBytes + measured.hostWeightBytes),
      static_cast<unsigned long long>(real.weightBytes),
      static_cast<unsigned long long>(
          measured.deviceIsCpu ? measured.hostComputeBytes
                               : measured.deviceComputeBytes),
      static_cast<unsigned long long>(real.deviceComputeBytes),
      static_cast<unsigned long long>(
          measured.deviceIsCpu ? 0 : measured.hostComputeBytes),
      static_cast<unsigned long long>(real.cpuComputeBytes),
      static_cast<unsigned long long>(measured.hostWorkBytes),
      static_cast<unsigned long long>(real.cpuWorkBytes),
      static_cast<unsigned long long>(measured.hostStagingBytes));
  EXPECT_GT(real.weightBytes, 0U) << label;
  EXPECT_GT(real.deviceComputeBytes, 0U) << label;
  if (measured.deviceIsCpu) {
    EXPECT_EQ(measured.deviceWeightBytes, 0U) << label;
    EXPECT_EQ(measured.deviceComputeBytes, 0U) << label;
    EXPECT_EQ(measured.hostWeightBytes, real.weightBytes) << label;
    EXPECT_EQ(measured.hostComputeBytes, real.deviceComputeBytes) << label;
    EXPECT_EQ(real.cpuComputeBytes, 0U) << label;
  } else {
    EXPECT_EQ(measured.hostWeightBytes, 0U) << label;
    EXPECT_EQ(measured.deviceWeightBytes, real.weightBytes) << label;
    EXPECT_EQ(measured.deviceComputeBytes, real.deviceComputeBytes) << label;
    EXPECT_EQ(measured.hostComputeBytes, real.cpuComputeBytes) << label;
  }
  EXPECT_EQ(measured.hostWorkBytes, real.cpuWorkBytes) << label;
  EXPECT_GT(measured.hostStagingBytes, 0U) << label;
}

void checkMegaLoc(const char* env) {
  const std::string path = envOr(env, "");
  if (path.empty())
    GTEST_SKIP() << env << " is not set";
  const auto measured =
      qcc::measureFootprint(path, backendName(), "", 0, 0, TEST_THREADS);
  EXPECT_EQ(measured.kind, qcc::ModelKind::MegaLoc);
  mega::MegaLocModel model({path, "", backendName(), TEST_THREADS});
  model.load();
  model.process(std::any(syntheticRgb(mega::IMAGE_SIZE, mega::IMAGE_SIZE, 0)));
  expectEqual(env, measured, model.allocatedBuffers());
}

void checkBridgeDepth(uint32_t width, uint32_t height) {
  const std::string path = envOr("QVAC_BRIDGEDEPTH_MODEL_PATH", "");
  if (path.empty())
    GTEST_SKIP() << "QVAC_BRIDGEDEPTH_MODEL_PATH is not set";
  const auto measured = qcc::measureFootprint(
      path,
      backendName(),
      "",
      static_cast<int>(width),
      static_cast<int>(height),
      TEST_THREADS);
  EXPECT_EQ(measured.kind, qcc::ModelKind::BridgeDepth);
  bd::BridgeDepthModel model({path, "", backendName(), TEST_THREADS});
  model.load();
  constexpr uint32_t rightViewShift = 5;
  const auto output = std::any_cast<bd::DisparityOutput>(model.process(
      std::any(
          bd::StereoInput{
              syntheticRgb(width, height, 0),
              syntheticRgb(width, height, rightViewShift)})));
  EXPECT_EQ(output.width, width);
  EXPECT_EQ(output.height, height);
  expectEqual(
      "bridgedepth " + std::to_string(width) + "x" + std::to_string(height),
      measured,
      model.allocatedBuffers());
}

} // namespace

TEST(ModelFootprint, MobileNetEqualsLoadedBuffers) {
  const std::string path = mobileNetPath();
  if (path.empty())
    GTEST_SKIP() << "MobileNet weights not found";
  // MobileNet loads on the CPU whatever backend is asked for.
  const auto measured = qcc::measureFootprint(path, backendName(), "", 0, 0);
  EXPECT_EQ(measured.kind, qcc::ModelKind::MobileNet);
  EXPECT_TRUE(measured.deviceIsCpu);
  qcc::ClassificationModel model(path);
  model.load();
  constexpr uint32_t side = qcc::graph::INPUT_HW;
  qcc::ClassifyInput input;
  static_cast<qcc::ImageInput&>(input) = syntheticRgb(side, side, 0);
  model.process(std::any(input));
  expectEqual("mobilenet", measured, model.allocatedBuffers());
}

TEST(ModelFootprint, MegaLocF16EqualsLoadedBuffers) {
  checkMegaLoc("QVAC_MEGALOC_F16_MODEL_PATH");
}

TEST(ModelFootprint, MegaLocMixedEqualsLoadedBuffers) {
  checkMegaLoc("QVAC_MEGALOC_MIXED_MODEL_PATH");
}

TEST(ModelFootprint, BridgeDepthFixtureSizeEqualsLoadedBuffers) {
  checkBridgeDepth(FIXTURE_WIDTH, FIXTURE_HEIGHT);
}

TEST(ModelFootprint, BridgeDepthHdEqualsLoadedBuffers) {
  checkBridgeDepth(HD_WIDTH, HD_HEIGHT);
}

// Above 1280x720 the pair is downsampled, so the loaded buffers equal the
// measure at this size and at 1280x720 alike.
TEST(ModelFootprint, BridgeDepthFullHdEqualsLoadedBuffers) {
  checkBridgeDepth(FULL_HD_WIDTH, FULL_HD_HEIGHT);
}

// The full HD measure is the 1280x720 one plus the disparity resized back to
// the input, which the inference phase holds on the host.
TEST(ModelFootprint, BridgeDepthAboveTheBoxIsSizedAtTheModelSize) {
  const std::string path = envOr("QVAC_BRIDGEDEPTH_MODEL_PATH", "");
  if (path.empty())
    GTEST_SKIP() << "QVAC_BRIDGEDEPTH_MODEL_PATH is not set";
  auto measure = [&](uint32_t width, uint32_t height) {
    return qcc::measureFootprint(
        path,
        backendName(),
        "",
        static_cast<int>(width),
        static_cast<int>(height),
        TEST_THREADS);
  };
  const auto hd = measure(HD_WIDTH, HD_HEIGHT);
  const auto fullHd = measure(FULL_HD_WIDTH, FULL_HD_HEIGHT);
  EXPECT_EQ(fullHd.deviceWeightBytes, hd.deviceWeightBytes);
  EXPECT_EQ(fullHd.deviceComputeBytes, hd.deviceComputeBytes);
  EXPECT_EQ(fullHd.hostWeightBytes, hd.hostWeightBytes);
  EXPECT_EQ(fullHd.hostComputeBytes, hd.hostComputeBytes);
  EXPECT_EQ(fullHd.hostWorkBytes, hd.hostWorkBytes);
  const uint64_t resizedDisparityBytes =
      static_cast<uint64_t>(FULL_HD_WIDTH) * FULL_HD_HEIGHT * sizeof(float);
  EXPECT_EQ(
      fullHd.hostStagingBytes, hd.hostStagingBytes + resizedDisparityBytes);
}

TEST(ModelFootprint, BridgeDepthRejectsSizesInferenceRejects) {
  const std::string path = envOr("QVAC_BRIDGEDEPTH_MODEL_PATH", "");
  if (path.empty())
    GTEST_SKIP() << "QVAC_BRIDGEDEPTH_MODEL_PATH is not set";
  const int tooSmall = bd::MIN_SIDE - 1;
  const int tooLarge = static_cast<int>(bd::MAX_SIDE);
  EXPECT_THROW(
      qcc::measureFootprint(path, "CPU", "", tooSmall, bd::MIN_SIDE),
      std::exception);
  // MAX_SIDE x MAX_SIDE passes the side limit and exceeds MAX_GRID_CELLS.
  EXPECT_THROW(
      qcc::measureFootprint(path, "CPU", "", tooLarge, tooLarge),
      std::exception);
  EXPECT_THROW(qcc::measureFootprint(path, "CPU", "", 0, 0), std::exception);
}

// The real allocator splits weights at ggml_backend_buft_get_max_size, which
// no backend on a test machine makes small enough to reach with these models,
// and a buffer type cannot be built outside ggml. So the split rule is checked
// on the CPU buffer type with a small max size passed in directly.
TEST(BufferSplits, FollowTheAllocatorRuleAndGetOneEmptyBufferEach) {
  // Loads the CPU backend module where backends are dynamic.
  const qcc::GgmlBackends backends("CPU", "", 1, "split test");
  auto* type = ggml_backend_get_default_buffer_type(backends.cpu());
  const size_t alignment = ggml_backend_buft_get_alignment(type);
  // F32 tensors of whole alignment units, so a tensor's padded size is its
  // byte size: three small ones, a view and one larger than the max size.
  const int64_t smallElements =
      static_cast<int64_t>(alignment * 4 / sizeof(float));
  const size_t smallBytes = static_cast<size_t>(smallElements) * sizeof(float);
  const size_t maxSize = 2 * smallBytes;
  constexpr size_t tensorCount = 5;
  const std::unique_ptr<ggml_context, decltype(&ggml_free)> ctx(
      ggml_init(
          {tensorCount * ggml_tensor_overhead(), nullptr, /*no_alloc=*/true}),
      ggml_free);
  ASSERT_NE(ctx, nullptr);
  auto* a = ggml_new_tensor_1d(ctx.get(), GGML_TYPE_F32, smallElements);
  auto* b = ggml_new_tensor_1d(ctx.get(), GGML_TYPE_F32, smallElements);
  auto* c = ggml_new_tensor_1d(ctx.get(), GGML_TYPE_F32, smallElements);
  auto* view = ggml_view_1d(ctx.get(), c, smallElements, 0);
  auto* large = ggml_new_tensor_1d(ctx.get(), GGML_TYPE_F32, 3 * smallElements);

  // Unlimited, everything is one buffer of the size ggml reports.
  const auto whole = qcc::planBufferSplits(ctx.get(), type, SIZE_MAX);
  ASSERT_EQ(whole.size(), 1U);
  EXPECT_EQ(
      whole[0].bytes,
      ggml_backend_alloc_ctx_tensors_from_buft_size(ctx.get(), type));

  // a + b fill the first buffer, c and its view the second, and the tensor
  // larger than the max size gets a buffer of its own.
  const auto plan = qcc::planBufferSplits(ctx.get(), type, maxSize);
  ASSERT_EQ(plan.size(), 3U);
  EXPECT_EQ(plan[0].bytes, 2 * smallBytes);
  EXPECT_EQ(plan[0].first, 0);
  EXPECT_EQ(plan[0].last, 2);
  EXPECT_EQ(plan[1].bytes, smallBytes);
  EXPECT_EQ(plan[1].first, 2);
  EXPECT_EQ(plan[1].last, 4);
  EXPECT_EQ(plan[2].bytes, 3 * smallBytes);
  EXPECT_EQ(plan[2].first, 4);
  EXPECT_EQ(plan[2].last, 5);

  const qcc::EmptyWeightBuffers buffers =
      qcc::placeOnEmptyWeightBuffers(ctx.get(), type, maxSize);
  EXPECT_EQ(buffers.size(), plan.size());
  EXPECT_EQ(a->buffer, b->buffer);
  EXPECT_NE(b->buffer, c->buffer);
  EXPECT_NE(c->buffer, large->buffer);
  EXPECT_EQ(view->data, nullptr);
  // Aligned, laid out in order and never overlapping, across buffers too.
  const auto address = [](const ggml_tensor* t) {
    return reinterpret_cast<uintptr_t>(t->data);
  };
  for (const auto* t : {a, b, c, large})
    EXPECT_EQ(address(t) % alignment, 0U);
  EXPECT_GE(address(b), address(a) + smallBytes);
  EXPECT_GE(address(c), address(b) + smallBytes);
  EXPECT_GE(address(large), address(c) + smallBytes);
}

// With the real max size, the measured and the allocated physical bytes of a
// context agree.
TEST(BufferSplits, MeasuredBytesEqualAllocatedBytes) {
  const qcc::GgmlBackends backends("CPU", "", 1, "split test");
  constexpr int64_t elementCount = 1000; // not a multiple of any alignment
  constexpr size_t tensorCount = 3;
  const std::unique_ptr<ggml_context, decltype(&ggml_free)> ctx(
      ggml_init(
          {tensorCount * ggml_tensor_overhead(), nullptr, /*no_alloc=*/true}),
      ggml_free);
  ASSERT_NE(ctx, nullptr);
  for (size_t i = 0; i < tensorCount; ++i)
    ggml_new_tensor_1d(ctx.get(), GGML_TYPE_F32, elementCount);
  const uint64_t measured = qcc::ctxBufferBytes(ctx.get(), backends.cpu());
  ggml_backend_buffer_t buffer =
      ggml_backend_alloc_ctx_tensors(ctx.get(), backends.cpu());
  ASSERT_NE(buffer, nullptr);
  EXPECT_EQ(qcc::allocatedCtxBytes(ctx.get()), measured);
  ggml_backend_buffer_free(buffer);
}

TEST(ModelFootprint, RejectsUnknownFiles) {
  EXPECT_THROW(
      qcc::measureFootprint("missing.gguf", "CPU", "", 0, 0), std::exception);
}

// Report only, run alone with --gtest_also_run_disabled_tests so the process
// peak is this test's: how much resident memory a real BridgeDepth load and
// 1280x720 inference add, next to the sum of the measured terms. getrusage is
// POSIX only, so Windows does not build it.
#if !defined(_WIN32)
TEST(ModelFootprint, DISABLED_ReportBridgeDepthResidentGrowth) {
  const std::string path = envOr("QVAC_BRIDGEDEPTH_MODEL_PATH", "");
  if (path.empty())
    GTEST_SKIP() << "QVAC_BRIDGEDEPTH_MODEL_PATH is not set";
  auto peakResident = [] {
    rusage usage{};
    getrusage(RUSAGE_SELF, &usage);
#if defined(__APPLE__)
    return static_cast<uint64_t>(usage.ru_maxrss); // bytes
#else
    constexpr uint64_t kibibyte = 1024;
    return static_cast<uint64_t>(usage.ru_maxrss) * kibibyte;
#endif
  };
  const auto left = syntheticRgb(HD_WIDTH, HD_HEIGHT, 0);
  const auto right = syntheticRgb(HD_WIDTH, HD_HEIGHT, 5);
  const uint64_t beforeMeasure = peakResident();
  const auto measured = qcc::measureFootprint(
      path,
      backendName(),
      "",
      static_cast<int>(HD_WIDTH),
      static_cast<int>(HD_HEIGHT),
      TEST_THREADS);
  const uint64_t afterMeasure = peakResident();
  bd::BridgeDepthModel model({path, "", backendName(), TEST_THREADS});
  model.load();
  const uint64_t afterLoad = peakResident();
  model.process(std::any(bd::StereoInput{left, right}));
  const uint64_t afterInfer = peakResident();
  const uint64_t terms = measured.deviceWeightBytes +
                         measured.deviceComputeBytes +
                         measured.hostWeightBytes + measured.hostComputeBytes +
                         measured.hostWorkBytes + measured.hostStagingBytes;
  std::printf(
      "RESIDENT %s peak before measure %llu, after measure %llu, after load "
      "%llu, after infer %llu; growth %llu; measured terms %llu (weights "
      "%llu, compute %llu, work %llu, staging %llu)\n",
      measured.deviceName.c_str(),
      static_cast<unsigned long long>(beforeMeasure),
      static_cast<unsigned long long>(afterMeasure),
      static_cast<unsigned long long>(afterLoad),
      static_cast<unsigned long long>(afterInfer),
      static_cast<unsigned long long>(afterInfer - afterMeasure),
      static_cast<unsigned long long>(terms),
      static_cast<unsigned long long>(
          measured.deviceWeightBytes + measured.hostWeightBytes),
      static_cast<unsigned long long>(
          measured.deviceComputeBytes + measured.hostComputeBytes),
      static_cast<unsigned long long>(measured.hostWorkBytes),
      static_cast<unsigned long long>(measured.hostStagingBytes));
}
#endif
