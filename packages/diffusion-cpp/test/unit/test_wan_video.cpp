#include <any>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include <gtest/gtest.h>

// stb headers -- implementation is compiled in SdModel.cpp.
#include <stb_image.h>
#include <stb_image_write.h>

#include "handlers/SdCtxHandlers.hpp"
#include "model-interface/SdModel.hpp"
#include "test_common.hpp"

using namespace qvac_lib_inference_addon_sd;

// ---------------------------------------------------------------------------
// Phase 5 integration tests -- exercise SdModel::process() dispatch on the
// "mode" top-level key and the pre-generation validation in processVideo().
//
// None of these tests actually call generate_video(); every path under test
// throws from processVideo() _before_ the library is invoked. They only
// need isLoaded()==true, so the fixture reuses the cheap SD2.1 context
// already downloaded for the other unit tests. A companion
// SdWanHappyPathTest fixture loads the full Wan 2.1 1.3B T2V model when
// available and runs a single end-to-end smoke test.
// ---------------------------------------------------------------------------

namespace wan_helpers {

// Paths under PROJECT_ROOT/models -- same layout as download-model-wan.sh.
inline std::string modelsDir() {
#ifdef PROJECT_ROOT
  return std::string(PROJECT_ROOT) + "/models";
#else
  return "models";
#endif
}

inline std::string wanDiffusionPath() {
  return modelsDir() + "/wan2.1_t2v_1.3B_fp16.safetensors";
}
inline std::string wanVaePath() {
  return modelsDir() + "/wan_2.1_vae.safetensors";
}
inline std::string wanT5Path() {
  return modelsDir() + "/umt5_xxl_fp16.safetensors";
}

// Create a small solid-colour PNG in memory. Channels = RGB (3).
inline std::vector<uint8_t>
makeSolidPng(int w, int h, uint8_t r, uint8_t g, uint8_t b) {
  std::vector<uint8_t> pixels(static_cast<size_t>(w) * h * 3);
  for (int i = 0; i < w * h; ++i) {
    pixels[i * 3 + 0] = r;
    pixels[i * 3 + 1] = g;
    pixels[i * 3 + 2] = b;
  }
  std::vector<uint8_t> out;
  stbi_write_png_to_func(
      [](void* ctx, void* data, int size) {
        auto* v = static_cast<std::vector<uint8_t>*>(ctx);
        const auto* b = static_cast<const uint8_t*>(data);
        v->insert(v->end(), b, b + size);
      },
      &out,
      w,
      h,
      3,
      pixels.data(),
      w * 3);
  return out;
}

inline bool isAvi(const std::vector<uint8_t>& buf) {
  if (buf.size() < 12)
    return false;
  return buf[0] == 'R' && buf[1] == 'I' && buf[2] == 'F' && buf[3] == 'F' &&
         buf[8] == 'A' && buf[9] == 'V' && buf[10] == 'I' && buf[11] == ' ';
}

} // namespace wan_helpers

// ---------------------------------------------------------------------------
// Validation-only fixture
//
// Loads SD2.1 (small, already present in CI) purely to satisfy the
// isLoaded() gate in SdModel::process(). Every test here relies on the
// validation error firing before generate_video() is even dispatched, so
// the underlying architecture does not matter.
// ---------------------------------------------------------------------------

class SdWanValidationTest : public ::testing::Test {
protected:
  static std::unique_ptr<SdModel> model;

  static void SetUpTestSuite() {
    const auto path = sd_test_helpers::getModelPath();
    if (path.empty())
      return;

    SdCtxConfig config{};
    config.modelPath = path;
    config.prediction = V_PRED;
    config.nThreads = sd_test_helpers::getTestThreads();
    config.device = sd_test_helpers::getTestDevice();

    model = std::make_unique<SdModel>(std::move(config));
    model->load();
  }

  static void TearDownTestSuite() { model.reset(); }

  void SetUp() override {
    if (!model)
      GTEST_SKIP() << "SD2.1 model not available -- set SD_TEST_MODEL_PATH or "
                      "download to test/model/ (validation tests reuse it to "
                      "satisfy isLoaded()).";
  }

  // Build and run a job, expecting a StatusError-derived throw whose message
  // contains `needle`. Using substring matching keeps the tests resilient to
  // wording tweaks while still pinning down which validation branch fired.
  static void
  expectThrowContains(SdModel::GenerationJob job, const std::string& needle) {
    try {
      model->process(std::any(job));
      FAIL() << "Expected processVideo to throw but it returned normally";
    } catch (const std::exception& e) {
      const std::string msg = e.what();
      EXPECT_NE(msg.find(needle), std::string::npos)
          << "Thrown message did not contain '" << needle << "'. Got: " << msg;
    }
  }
};

std::unique_ptr<SdModel> SdWanValidationTest::model = nullptr;

// ---------------------------------------------------------------------------
// Unknown "mode" value routes to processImage() (not processVideo())
// ---------------------------------------------------------------------------
//
// Guards the dispatch contract: only the three known video modes flip the
// isVideo branch in process(). Any other string falls through to the image
// pipeline, which has its own handler-level validation.
// ---------------------------------------------------------------------------

TEST_F(SdWanValidationTest, UnknownModeFallsThroughToImagePath) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "bogus",
    "prompt": "test"
  })";

  try {
    model->process(std::any(job));
    FAIL() << "Expected throw from SdGenHandlers' mode validator";
  } catch (const std::exception& e) {
    // Accept any error that clearly originates from image-path handlers:
    // unknown 'mode' rejected by SdGenHandlers, or later stages that only
    // exist in processImage(). Explicitly NOT the video-specific strings
    // we assert in the tests below.
    const std::string msg = e.what();
    EXPECT_EQ(msg.find("processVideo"), std::string::npos)
        << "Unknown mode should route to processImage, not processVideo. "
           "Got: "
        << msg;
    EXPECT_EQ(msg.find("txt2vid"), std::string::npos);
    EXPECT_EQ(msg.find("img2vid"), std::string::npos);
    EXPECT_EQ(msg.find("flf2vid"), std::string::npos);
  }
}

TEST_F(SdWanValidationTest, NonStringModeRejected) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({ "mode": 42, "prompt": "test" })";
  expectThrowContains(std::move(job), "mode must be a string");
}

// ---------------------------------------------------------------------------
// img2vid missing init_image
// ---------------------------------------------------------------------------

TEST_F(SdWanValidationTest, Img2VidRejectsMissingInitImage) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "img2vid",
    "prompt": "animate the frame",
    "video_frames": 5
  })";
  // No init_image bytes attached -> validation fires.
  expectThrowContains(std::move(job), "img2vid: init_image is required");
}

// ---------------------------------------------------------------------------
// flf2vid missing init_image or end_image
// ---------------------------------------------------------------------------

TEST_F(SdWanValidationTest, Flf2VidRejectsMissingInitImage) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "flf2vid",
    "prompt": "interpolate",
    "video_frames": 5
  })";
  // endImageBytes provided alone is not enough -- init (first frame) required.
  job.endImageBytes = wan_helpers::makeSolidPng(64, 64, 10, 20, 30);
  expectThrowContains(
      std::move(job), "flf2vid: init_image (first frame) is required");
}

TEST_F(SdWanValidationTest, Flf2VidRejectsMissingEndImage) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "flf2vid",
    "prompt": "interpolate",
    "video_frames": 5
  })";
  job.initImageBytes = wan_helpers::makeSolidPng(64, 64, 10, 20, 30);
  expectThrowContains(
      std::move(job), "flf2vid: end_image (last frame) is required");
}

// ---------------------------------------------------------------------------
// end_image with non-flf2vid mode
// ---------------------------------------------------------------------------

TEST_F(SdWanValidationTest, Img2VidRejectsEndImage) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "img2vid",
    "prompt": "animate",
    "video_frames": 5
  })";
  job.initImageBytes = wan_helpers::makeSolidPng(64, 64, 10, 20, 30);
  job.endImageBytes = wan_helpers::makeSolidPng(64, 64, 90, 80, 70);
  expectThrowContains(
      std::move(job), "end_image is only valid for mode='flf2vid'");
}

TEST_F(SdWanValidationTest, Txt2VidRejectsEndImage) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "txt2vid",
    "prompt": "pure prompt",
    "video_frames": 5
  })";
  job.endImageBytes = wan_helpers::makeSolidPng(64, 64, 90, 80, 70);
  // No init bytes on txt2vid, but end_image + txt2vid should still be
  // caught by the end-without-flf guard.
  expectThrowContains(
      std::move(job), "end_image is only valid for mode='flf2vid'");
}

// ---------------------------------------------------------------------------
// txt2vid with init_image
// ---------------------------------------------------------------------------

TEST_F(SdWanValidationTest, Txt2VidRejectsInitImage) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "txt2vid",
    "prompt": "pure prompt",
    "video_frames": 5
  })";
  job.initImageBytes = wan_helpers::makeSolidPng(64, 64, 10, 20, 30);
  expectThrowContains(std::move(job), "txt2vid does not accept init_image");
}

// ---------------------------------------------------------------------------
// Decode failures (bad PNG bytes for init / end / control frames)
// ---------------------------------------------------------------------------

TEST_F(SdWanValidationTest, Img2VidRejectsCorruptInitImage) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "img2vid",
    "prompt": "animate",
    "video_frames": 5
  })";
  // 12 random bytes that are neither PNG nor JPEG.
  job.initImageBytes = {
      0x00, 0xFF, 0xAA, 0x01, 0x02, 0x03, 0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22};
  expectThrowContains(
      std::move(job), "processVideo: failed to decode init_image");
}

TEST_F(SdWanValidationTest, Flf2VidRejectsCorruptEndImage) {
  // Pin width/height to 64 so the new init_image dim check above passes
  // for the 64x64 init and we still reach the intended end-decode-failure
  // path. Without the pin, this test would now fail on init_image dim
  // mismatch (defaults are 480x832) before end_image is even decoded.
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "flf2vid",
    "prompt": "interpolate",
    "width": 64,
    "height": 64,
    "video_frames": 5
  })";
  job.initImageBytes = wan_helpers::makeSolidPng(64, 64, 10, 20, 30);
  job.endImageBytes = {
      0x00, 0xFF, 0xAA, 0x01, 0x02, 0x03, 0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22};
  expectThrowContains(
      std::move(job), "processVideo: failed to decode end_image");
}

TEST_F(SdWanValidationTest, Img2VidRejectsCorruptControlFrame) {
  SdModel::GenerationJob job;
  // Pin width/height to the control-frame size so the (new) dimension check
  // in processVideo() passes for frame [0] and we reach the decode-failure
  // path for frame [1] that this test is exercising.
  job.paramsJson = R"({
    "mode": "img2vid",
    "prompt": "animate with VACE guidance",
    "width": 64,
    "height": 64,
    "video_frames": 5
  })";
  job.initImageBytes = wan_helpers::makeSolidPng(64, 64, 10, 20, 30);
  // First control frame is valid PNG; second is junk -- index should be 1.
  job.controlFramesBytes.push_back(
      wan_helpers::makeSolidPng(64, 64, 100, 110, 120));
  job.controlFramesBytes.push_back(
      {0x00, 0xFF, 0xAA, 0x01, 0x02, 0x03, 0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22});
  expectThrowContains(
      std::move(job), "processVideo: failed to decode control_frames[1]");
}

// ---------------------------------------------------------------------------
// Dimension validation (added in QVAC-18026 follow-up): init_image,
// end_image and every control_frames entry must match the video
// width/height before we hand pointers to generate_video(), which would
// otherwise see mismatched stride and either segfault inside the VAE or
// silently produce garbage.
// ---------------------------------------------------------------------------

TEST_F(SdWanValidationTest, Img2VidRejectsInitImageWithWrongDimensions) {
  // Pin video at 64x64 but ship a 96x96 init_image; the new check in
  // processVideo() must fire BEFORE generate_video() is dispatched.
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "img2vid",
    "prompt": "animate the frame",
    "width": 64,
    "height": 64,
    "video_frames": 5
  })";
  job.initImageBytes = wan_helpers::makeSolidPng(96, 96, 10, 20, 30);
  expectThrowContains(
      std::move(job),
      "processVideo: init_image dimensions 96x96 do not match video "
      "dimensions 64x64");
}

TEST_F(SdWanValidationTest, Flf2VidRejectsInitImageWithWrongDimensions) {
  // Same check applies to flf2vid (init = first frame). The mismatch here
  // must be caught at init_image decode, not at end_image decode, so we
  // ship a matching end_image to prove the early-out fires first.
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "flf2vid",
    "prompt": "interpolate",
    "width": 64,
    "height": 64,
    "video_frames": 5
  })";
  job.initImageBytes = wan_helpers::makeSolidPng(128, 128, 10, 20, 30);
  job.endImageBytes = wan_helpers::makeSolidPng(64, 64, 90, 80, 70);
  expectThrowContains(
      std::move(job),
      "processVideo: init_image dimensions 128x128 do not match video "
      "dimensions 64x64");
}

TEST_F(SdWanValidationTest, Flf2VidRejectsEndImageWithWrongDimensions) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "flf2vid",
    "prompt": "interpolate",
    "width": 64,
    "height": 64,
    "video_frames": 5
  })";
  job.initImageBytes = wan_helpers::makeSolidPng(64, 64, 10, 20, 30);
  // end_image is 96x96 -- explicitly different from width/height = 64x64.
  job.endImageBytes = wan_helpers::makeSolidPng(96, 96, 90, 80, 70);
  expectThrowContains(
      std::move(job),
      "processVideo: end_image dimensions 96x96 do not match video "
      "dimensions 64x64");
}

TEST_F(SdWanValidationTest, Img2VidRejectsControlFrameWithWrongDimensions) {
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "img2vid",
    "prompt": "animate with VACE guidance",
    "width": 64,
    "height": 64,
    "video_frames": 5
  })";
  job.initImageBytes = wan_helpers::makeSolidPng(64, 64, 10, 20, 30);
  // First control frame matches; second is wrong size -- error must call
  // out index 1 specifically so users can find the offending input quickly.
  job.controlFramesBytes.push_back(
      wan_helpers::makeSolidPng(64, 64, 100, 110, 120));
  job.controlFramesBytes.push_back(
      wan_helpers::makeSolidPng(128, 128, 200, 210, 220));
  expectThrowContains(
      std::move(job),
      "processVideo: control_frames[1] dimensions 128x128 do not match "
      "video dimensions 64x64");
}

// ---------------------------------------------------------------------------
// Sanity check: the job callbacks are cleared on the validation throw path.
// ---------------------------------------------------------------------------
//
// process() installs a CallbackGuard that clears tl_progressCtx + the
// sd_set_progress_callback/sd_set_abort_callback hooks on every exit path.
// If validation throws in processVideo() BEFORE the guard runs, we'd leak
// a dangling pointer to the freed job. Re-running a second job right after
// a validation throw must not crash -- it would if the TLS pointer still
// referenced the dead first job's progressCallback.
// ---------------------------------------------------------------------------

TEST_F(SdWanValidationTest, ValidationThrowClearsThreadLocalState) {
  SdModel::GenerationJob bad;
  bad.paramsJson = R"({
    "mode": "img2vid",
    "prompt": "missing init",
    "video_frames": 5
  })";

  EXPECT_ANY_THROW(model->process(std::any(bad)));

  // Second validation throw in a row -- must not crash or re-enter the
  // previous job's progressCallback via stale TLS.
  SdModel::GenerationJob bad2;
  bad2.paramsJson = R"({
    "mode": "flf2vid",
    "prompt": "missing end",
    "video_frames": 5
  })";
  bad2.initImageBytes = wan_helpers::makeSolidPng(64, 64, 10, 20, 30);
  EXPECT_ANY_THROW(model->process(std::any(bad2)));
}

// ---------------------------------------------------------------------------
// Happy-path smoke test (Wan 2.1 1.3B T2V)
//
// Opt-in: only runs when every Wan 2.1 model file is present. Downloads
// are ~8 GB so CI keeps them behind a separate fixture to avoid pulling
// them for every unit-test build.
// ---------------------------------------------------------------------------

class SdWanHappyPathTest : public ::testing::Test {
protected:
  static std::unique_ptr<SdModel> model;

  static void SetUpTestSuite() {
    // Opt-in: a full Wan 2.1 T2V generation takes ~55s on M3 Ultra Metal and
    // requires several GB of model weights, so we keep the smoke test behind
    // an explicit env var. Metal IM2COL_3D / PAD-left ops are provided by the
    // tetherto/qvac-ext-ggml fork pinned in vcpkg/ports/ggml/ -- see
    // vcpkg/ports/ggml/portfile.cmake for details. CPU and Vulkan also work.
    if (!std::getenv("SD_RUN_WAN_SMOKE"))
      return;

    const std::string diff = wan_helpers::wanDiffusionPath();
    const std::string vae = wan_helpers::wanVaePath();
    const std::string t5 = wan_helpers::wanT5Path();

    if (!std::filesystem::exists(diff) || !std::filesystem::exists(vae) ||
        !std::filesystem::exists(t5)) {
      std::cout << "[SKIP] Wan 2.1 model files not found. Run "
                << "./scripts/download-model-wan.sh to enable this test.\n";
      return;
    }

    SdCtxConfig config{};
    config.diffusionModelPath = diff;
    config.vaePath = vae;
    config.t5XxlPath = t5;
    config.nThreads = sd_test_helpers::getTestThreads();
    config.device = sd_test_helpers::getTestDevice();

    std::cout << "[SdWanHappyPathTest] Loading Wan 2.1 T2V 1.3B...\n"
              << "  diffusion : " << diff << "\n"
              << "  vae       : " << vae << "\n"
              << "  t5xxl     : " << t5 << "\n";

    model = std::make_unique<SdModel>(std::move(config));
    model->load();
    std::cout << "[SdWanHappyPathTest] Model loaded.\n";
  }

  static void TearDownTestSuite() { model.reset(); }

  void SetUp() override {
    if (!model)
      GTEST_SKIP() << "Wan smoke test skipped. To enable: set "
                      "SD_RUN_WAN_SMOKE=1 (requires Wan 2.1 files under "
                      "models/ -- run ./scripts/download-model-wan.sh).";
  }
};

std::unique_ptr<SdModel> SdWanHappyPathTest::model = nullptr;

TEST_F(SdWanHappyPathTest, Txt2VidProducesValidAvi) {
  // 5 frames @ 832x480 is the minimum (4k+1 where k=1) -- keeps the test
  // bearable while still exercising the full VAE decode + AVI mux path.
  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "txt2vid",
    "prompt": "a cat slowly blinking",
    "negative_prompt": "blurry, low quality",
    "width": 832,
    "height": 480,
    "video_frames": 5,
    "fps": 16,
    "steps": 2,
    "cfg_scale": 6.0,
    "seed": 42
  })";

  std::vector<uint8_t> avi;
  int progressTicks = 0;
  job.progressCallback = [&](const std::string&) { ++progressTicks; };
  job.outputCallback = [&](const std::vector<uint8_t>& bytes) { avi = bytes; };

  EXPECT_NO_THROW(model->process(std::any(job)));

  EXPECT_FALSE(avi.empty()) << "outputCallback should fire once with AVI bytes";
  EXPECT_TRUE(wan_helpers::isAvi(avi))
      << "Output must be a valid RIFF/AVI container";
  EXPECT_GT(progressTicks, 0)
      << "progressCallback should fire during denoising";
}

// ---------------------------------------------------------------------------
// img2vid happy path on the Wan 2.1 1.3B T2V checkpoint
//
// Wan 2.1 1.3B can accept an init_image as a first frame even though it
// was trained primarily for T2V; examples/img2vid-wan.js relies on this
// exact behaviour. Here we exercise the same path under the validation
// fixture's umbrella to prove:
//   - init_image bytes are decoded and forwarded to generate_video()
//   - the dimension check we just added does NOT spuriously fire when
//     init_image matches width/height
//   - img_cfg falls through to cfg_scale (sentinel -1) without any caller
//     having to set img_cfg_scale explicitly
//   - the frameCallback fan-out fires exactly video_frames times
// Same opt-in env var as the txt2vid smoke; same model on disk.
// ---------------------------------------------------------------------------

TEST_F(SdWanHappyPathTest, Img2VidProducesValidAvi) {
  // Build a 832x480 init frame in memory -- pure-grey background so we
  // don't have to ship a fixture image. Wan 2.1 native res is 832x480.
  const int kW = 832;
  const int kH = 480;
  const std::vector<uint8_t> initPng =
      wan_helpers::makeSolidPng(kW, kH, 128, 128, 128);

  SdModel::GenerationJob job;
  job.paramsJson = R"({
    "mode": "img2vid",
    "prompt": "a soft breeze moves through the frame",
    "negative_prompt": "blurry, low quality, jitter",
    "width": 832,
    "height": 480,
    "video_frames": 5,
    "fps": 16,
    "steps": 2,
    "cfg_scale": 6.0,
    "strength": 0.8,
    "flow_shift": 3.0,
    "seed": 42
  })";
  job.initImageBytes = initPng;

  std::vector<uint8_t> avi;
  int progressTicks = 0;
  int frameFanout = 0;
  job.progressCallback = [&](const std::string&) { ++progressTicks; };
  job.outputCallback = [&](const std::vector<uint8_t>& bytes) { avi = bytes; };
  job.frameCallback =
      [&](const std::vector<uint8_t>& png, int idx, int total) {
        EXPECT_FALSE(png.empty());
        EXPECT_GE(idx, 0);
        EXPECT_EQ(total, 5);
        ++frameFanout;
      };

  EXPECT_NO_THROW(model->process(std::any(job)));

  EXPECT_FALSE(avi.empty()) << "outputCallback should fire once with AVI bytes";
  EXPECT_TRUE(wan_helpers::isAvi(avi))
      << "Output must be a valid RIFF/AVI container";
  EXPECT_GT(progressTicks, 0)
      << "progressCallback should fire during denoising";
  EXPECT_EQ(frameFanout, 5)
      << "frameCallback should fire exactly video_frames times";
}

// ---------------------------------------------------------------------------
// img2vid with von-neumann.jpg and file output
// ---------------------------------------------------------------------------

TEST_F(SdWanHappyPathTest, Img2VidWithVonNeumannSavesOutput) {
  // Load and resize von-neumann.jpg to 832x480 for Wan compatibility
  const std::string models_dir = std::string(PROJECT_ROOT) + "/models";
  std::string init_image_path = models_dir + "/../assets/von-neumann.jpg";
  
  if (!std::filesystem::exists(init_image_path)) {
    GTEST_SKIP() << "von-neumann.jpg not found at " << init_image_path;
  }

  // Load and resize image to 832x480
  std::ifstream init_file(init_image_path, std::ios::binary);
  std::vector<uint8_t> image_bytes((std::istreambuf_iterator<char>(init_file)),
                                    std::istreambuf_iterator<char>());
  
  int w, h, channels;
  unsigned char* pixels = stbi_load_from_memory(image_bytes.data(), image_bytes.size(),
                                                 &w, &h, &channels, 3);
  if (!pixels) {
    GTEST_SKIP() << "Failed to decode von-neumann.jpg";
  }

  // Resize to 832x480 using simple nearest-neighbor
  const int target_w = 832, target_h = 480;
  std::vector<unsigned char> resized(target_w * target_h * 3);
  for (int y = 0; y < target_h; ++y) {
    for (int x = 0; x < target_w; ++x) {
      int src_x = (x * w) / target_w;
      int src_y = (y * h) / target_h;
      src_x = std::min(src_x, w - 1);
      src_y = std::min(src_y, h - 1);
      
      int src_idx = (src_y * w + src_x) * 3;
      int dst_idx = (y * target_w + x) * 3;
      resized[dst_idx] = pixels[src_idx];
      resized[dst_idx + 1] = pixels[src_idx + 1];
      resized[dst_idx + 2] = pixels[src_idx + 2];
    }
  }
  stbi_image_free(pixels);

  // Encode to PNG
  std::vector<unsigned char> png_bytes;
  auto png_writer = [](void* context, void* data, int size) {
    auto* v = (std::vector<unsigned char>*)context;
    v->insert(v->end(), (unsigned char*)data, (unsigned char*)data + size);
  };
  stbi_write_png_to_func(png_writer, &png_bytes, target_w, target_h, 3, resized.data(), 0);
  
  SdModel::GenerationJob job;
  // 81 frames = 5.06 seconds @ 16 fps (Wan's recommended max)
  job.paramsJson = R"({
    "mode": "img2vid",
    "prompt": "the man slowly turns his head and blinks, soft natural lighting, subtle camera push-in, fine film grain, cinematic",
    "negative_prompt": "blurry, distorted, low quality, jittery, static, frozen, watermark, double face, extra limbs",
    "width": 832,
    "height": 480,
    "video_frames": 81,
    "fps": 16,
    "steps": 30,
    "cfg_scale": 6.0,
    "img_cfg_scale": 1.5,
    "strength": 0.8,
    "flow_shift": 3.0,
    "seed": 42
  })";
  job.initImageBytes = png_bytes;

  std::vector<uint8_t> avi;
  int progressTicks = 0;
  int frameFanout = 0;
  
  job.progressCallback = [&](const std::string&) { ++progressTicks; };
  job.outputCallback = [&](const std::vector<uint8_t>& bytes) { avi = bytes; };
  job.frameCallback =
      [&](const std::vector<uint8_t>& png, int idx, int total) {
        EXPECT_FALSE(png.empty());
        EXPECT_EQ(total, 81);
        if (idx == 0 || idx == 40 || idx == 80) {
          std::cout << "  Frame " << idx << "/" << total << "\n";
        }
        ++frameFanout;
      };

  std::cout << "Running img2vid with von-neumann.jpg resized (81 frames, 5.06s @ 16fps, 30 steps)...\n";
  EXPECT_NO_THROW(model->process(std::any(job)));

  EXPECT_FALSE(avi.empty()) << "outputCallback should fire once with AVI bytes";
  EXPECT_TRUE(wan_helpers::isAvi(avi))
      << "Output must be a valid RIFF/AVI container";
  EXPECT_GT(progressTicks, 0)
      << "progressCallback should fire during denoising";
  EXPECT_EQ(frameFanout, 81)
      << "frameCallback should fire exactly 81 times";

  // Save output file
  std::string output_dir = std::string(PROJECT_ROOT) + "/output";
  std::filesystem::create_directories(output_dir);
  std::string output_path = output_dir + "/wan_img2vid_cpp_von_neumann_5sec.avi";
  
  std::ofstream output_file(output_path, std::ios::binary);
  if (output_file.is_open()) {
    output_file.write(reinterpret_cast<const char*>(avi.data()), avi.size());
    output_file.close();
    std::cout << "✓ Saved output AVI: " << output_path << " (" << avi.size()
              << " bytes, 5.06 seconds)\n";
  } else {
    ADD_FAILURE() << "Failed to open output file: " << output_path;
  }
}

// ---------------------------------------------------------------------------
// Dedicated Wan 2.1 I2V (14B) happy path
//
// Separate from SdWanHappyPathTest because the dedicated I2V checkpoint is
// 14B (~16-32 GB depending on precision) and is downloaded via the
// purpose-built ./scripts/download-model-wan-i2v.sh, not the regular
// download-model-wan.sh. Opt in via SD_RUN_WAN_I2V_SMOKE=1.
//
// The fixture probes models/ for any of the four supported variant
// filenames (480p/720p x fp16/bf16/fp8_e4m3fn/fp8_scaled) and uses the
// first one it finds; this matches the variant matrix in the download
// script. Width/height are pinned to the resolution that variant was
// trained on, so a user can pre-download either resolution and the test
// adapts.
// ---------------------------------------------------------------------------

namespace wan_helpers {

struct I2vModelChoice {
  std::string path;
  int width = 0;
  int height = 0;
};

// Probes models/ in the same order the download script's defaults pick:
// 480p fp8_scaled first (smallest, default), then 480p variants, then 720p.
inline I2vModelChoice findI2vModel() {
  struct Candidate {
    const char* filename;
    int width;
    int height;
  };
  static constexpr Candidate kCandidates[] = {
      {"wan2.1_i2v_480p_14B_fp8_scaled.safetensors", 832, 480},
      {"wan2.1_i2v_480p_14B_fp8_e4m3fn.safetensors", 832, 480},
      {"wan2.1_i2v_480p_14B_bf16.safetensors", 832, 480},
      {"wan2.1_i2v_480p_14B_fp16.safetensors", 832, 480},
      {"wan2.1_i2v_720p_14B_fp8_scaled.safetensors", 1280, 720},
      {"wan2.1_i2v_720p_14B_fp8_e4m3fn.safetensors", 1280, 720},
      {"wan2.1_i2v_720p_14B_bf16.safetensors", 1280, 720},
      {"wan2.1_i2v_720p_14B_fp16.safetensors", 1280, 720},
  };
  const std::string dir = modelsDir();
  for (const auto& c : kCandidates) {
    const std::string full = dir + "/" + c.filename;
    if (std::filesystem::exists(full))
      return {full, c.width, c.height};
  }
  return {};
}

} // namespace wan_helpers

class SdWanI2vHappyPathTest : public ::testing::Test {
protected:
  static std::unique_ptr<SdModel> model;
  static wan_helpers::I2vModelChoice choice;

  static void SetUpTestSuite() {
    // Opt-in: full 14B I2V generation needs >= 32 GB unified memory and
    // takes minutes even with just 2 steps, so we keep it behind an
    // explicit env var distinct from SD_RUN_WAN_SMOKE.
    if (!std::getenv("SD_RUN_WAN_I2V_SMOKE"))
      return;

    choice = wan_helpers::findI2vModel();
    const std::string vae = wan_helpers::wanVaePath();
    const std::string t5 = wan_helpers::wanT5Path();

    if (choice.path.empty() || !std::filesystem::exists(vae) ||
        !std::filesystem::exists(t5)) {
      std::cout << "[SKIP] Wan 2.1 I2V model files not found. Run "
                << "./scripts/download-model-wan-i2v.sh to enable this "
                   "test.\n";
      return;
    }

    SdCtxConfig config{};
    config.diffusionModelPath = choice.path;
    config.vaePath = vae;
    config.t5XxlPath = t5;
    config.nThreads = sd_test_helpers::getTestThreads();
    config.device = sd_test_helpers::getTestDevice();
    // 14B I2V is large enough that vanilla VRAM allocation often fails on
    // <=24 GB devices without CPU offload. Mirror the example default.
    config.offloadToCpu = true;
    // Flash attention is strongly recommended for Wan on Metal / CUDA --
    // matches the JS example default.
    config.diffusionFlashAttn = true;

    std::cout << "[SdWanI2vHappyPathTest] Loading Wan 2.1 I2V 14B...\n"
              << "  diffusion : " << choice.path << "\n"
              << "  vae       : " << vae << "\n"
              << "  t5xxl     : " << t5 << "\n"
              << "  trained res : " << choice.width << "x" << choice.height
              << "\n";

    model = std::make_unique<SdModel>(std::move(config));
    model->load();
    std::cout << "[SdWanI2vHappyPathTest] Model loaded.\n";
  }

  static void TearDownTestSuite() { model.reset(); }

  void SetUp() override {
    if (!model)
      GTEST_SKIP() << "Wan I2V smoke test skipped. To enable: set "
                      "SD_RUN_WAN_I2V_SMOKE=1 and download a Wan 2.1 I2V "
                      "variant via ./scripts/download-model-wan-i2v.sh.";
  }
};

std::unique_ptr<SdModel> SdWanI2vHappyPathTest::model = nullptr;
wan_helpers::I2vModelChoice SdWanI2vHappyPathTest::choice{};

TEST_F(SdWanI2vHappyPathTest, DedicatedI2vCheckpointProducesValidAvi) {
  // Build prompt JSON inline so width/height adapt to whichever I2V
  // resolution variant the user downloaded.
  const std::string paramsJson = std::string(R"({
    "mode": "img2vid",
    "prompt": "gentle camera push-in, cinematic lighting",
    "negative_prompt": "blurry, distorted, low quality, jittery",
    "width": )") +
      std::to_string(choice.width) + R"(,
    "height": )" +
      std::to_string(choice.height) + R"(,
    "video_frames": 5,
    "fps": 16,
    "steps": 2,
    "cfg_scale": 6.0,
    "img_cfg_scale": 1.5,
    "strength": 0.85,
    "flow_shift": 3.0,
    "seed": 42
  })";

  SdModel::GenerationJob job;
  job.paramsJson = paramsJson;
  job.initImageBytes =
      wan_helpers::makeSolidPng(choice.width, choice.height, 120, 130, 140);

  std::vector<uint8_t> avi;
  int progressTicks = 0;
  int frameFanout = 0;
  job.progressCallback = [&](const std::string&) { ++progressTicks; };
  job.outputCallback = [&](const std::vector<uint8_t>& bytes) { avi = bytes; };
  job.frameCallback =
      [&](const std::vector<uint8_t>& png, int /*idx*/, int total) {
        EXPECT_FALSE(png.empty());
        EXPECT_EQ(total, 5);
        ++frameFanout;
      };

  EXPECT_NO_THROW(model->process(std::any(job)));

  EXPECT_FALSE(avi.empty()) << "outputCallback should fire once with AVI bytes";
  EXPECT_TRUE(wan_helpers::isAvi(avi))
      << "Output must be a valid RIFF/AVI container";
  EXPECT_GT(progressTicks, 0)
      << "progressCallback should fire during denoising";
  EXPECT_EQ(frameFanout, 5)
      << "frameCallback should fire exactly video_frames times";
}
