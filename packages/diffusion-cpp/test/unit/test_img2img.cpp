#include <any>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

#include <gtest/gtest.h>

// stb headers — implementation already compiled in SdModel.cpp,
// so we include the headers here WITHOUT the _IMPLEMENTATION guard.
#include <stb_image.h>
#include <stb_image_write.h>

#include "handlers/SdCtxHandlers.hpp"
#include "model-interface/SdModel.hpp"
#include "test_common.hpp"

using namespace qvac_lib_inference_addon_sd;

// ── Helpers ──────────────────────────────────────────────────────────────────

namespace img2img_helpers {

// Returns path to FLUX2 models directory (PROJECT_ROOT/models/).
inline std::string modelsDir() {
#ifdef PROJECT_ROOT
  return std::string(PROJECT_ROOT) + "/models";
#else
  return "models";
#endif
}

inline std::string headshotPath() {
#ifdef PROJECT_ROOT
  return std::string(PROJECT_ROOT) + "/assets/von-neumann.jpg";
#else
  return "assets/von-neumann.jpg";
#endif
}

// Create a W×H solid-colour PNG in memory. Channels = RGB (3).
std::vector<uint8_t>
makeSolidPng(int w, int h, uint8_t r, uint8_t g, uint8_t b) {
  std::vector<uint8_t> pixels(w * h * 3);
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

// Read a file from disk into a byte vector.
std::vector<uint8_t> readFile(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(f), {}};
}

// Decode PNG/JPEG bytes with stb_image and return the (w, h) dimensions.
// Returns {0, 0} on failure.
std::pair<int, int> decodeDimensions(const std::vector<uint8_t>& bytes) {
  int w = 0, h = 0, c = 0;
  int success = stbi_info_from_memory(
      bytes.data(), static_cast<int>(bytes.size()), &w, &h, &c);
  if (!success)
    return {0, 0};
  return {w, h};
}

// Serialise bytes to a JSON array string: [0,255,128,...]
std::string bytesToJsonArray(const std::vector<uint8_t>& bytes) {
  std::ostringstream oss;
  oss << "[";
  for (size_t i = 0; i < bytes.size(); ++i) {
    if (i)
      oss << ",";
    oss << static_cast<int>(bytes[i]);
  }
  oss << "]";
  return oss.str();
}

// Build paramsJson for an img2img job.
// If w/h == 0 they are omitted (the model sees the SdGenConfig defaults).
std::string makeImg2ImgParams(
    const std::vector<uint8_t>& initBytes, int w, int h, int steps = 1,
    int64_t seed = 42) {
  std::ostringstream oss;
  oss << R"({"mode":"img2img","prompt":"a professional portrait",)"
      << R"("negative_prompt":"blurry","steps":)" << steps
      << R"(,"strength":0.5,"seed":)" << seed;
  if (w > 0)
    oss << R"(,"width":)" << w;
  if (h > 0)
    oss << R"(,"height":)" << h;
  oss << R"(,"init_image_bytes":)" << bytesToJsonArray(initBytes) << "}";
  return oss.str();
}

} // namespace img2img_helpers

// ── Fixture ──────────────────────────────────────────────────────────────────

class SdImg2ImgTest : public ::testing::Test {
protected:
  static std::unique_ptr<SdModel> model;

  static void SetUpTestSuite() {
    const auto dir = img2img_helpers::modelsDir();
    const std::string diffModel = dir + "/flux-2-klein-4b-Q8_0.gguf";
    const std::string llmModel = dir + "/Qwen3-4B-Q4_K_M.gguf";
    const std::string vaeModel = dir + "/flux2-vae.safetensors";

    if (!std::filesystem::exists(diffModel) ||
        !std::filesystem::exists(llmModel) ||
        !std::filesystem::exists(vaeModel)) {
      std::cout << "[SKIP] FLUX2 models not found in: " << dir << "\n"
                << "       Run ./scripts/download-model-i2i.sh first.\n";
      return;
    }

    SdCtxConfig cfg{};
    cfg.diffusionModelPath = diffModel;
    cfg.llmPath = llmModel;
    cfg.vaePath = vaeModel;
    cfg.prediction = FLUX2_FLOW_PRED;
    cfg.nThreads = sd_test_helpers::getTestThreads();
    cfg.device = sd_test_helpers::getTestDevice();

    std::cout << "[SdImg2ImgTest] Loading FLUX2-klein...\n"
              << "  diffusion : " << diffModel << "\n"
              << "  llm       : " << llmModel << "\n"
              << "  vae       : " << vaeModel << "\n";

    model = std::make_unique<SdModel>(std::move(cfg));
    model->load();
    std::cout << "[SdImg2ImgTest] Model loaded.\n";
  }

  static void TearDownTestSuite() { model.reset(); }

  void SetUp() override {
    if (!model)
      GTEST_SKIP() << "FLUX2 models not available — run download-model-i2i.sh";
  }
};

std::unique_ptr<SdModel> SdImg2ImgTest::model = nullptr;

// ── Diagnostic: print what stb_image sees for the headshot ───────────────────

TEST(SdImg2ImgDiagnostics, PrintHeadshotDimensions) {
  const auto path = img2img_helpers::headshotPath();
  if (!std::filesystem::exists(path)) {
    GTEST_SKIP() << "Headshot not found at: " << path;
  }

  const auto bytes = img2img_helpers::readFile(path);
  ASSERT_GT(bytes.size(), 0u) << "Headshot file is empty";

  const auto [w, h] = img2img_helpers::decodeDimensions(bytes);
  std::cout << "\n[Diagnostic] Headshot path     : " << path << "\n"
            << "[Diagnostic] Headshot file size : " << bytes.size()
            << " bytes\n"
            << "[Diagnostic] Decoded dimensions : " << w << " x " << h << "\n"
            << "[Diagnostic] SdGenConfig default: 512 x 512\n"
            << "[Diagnostic] Dimension match    : "
            << (w == 512 && h == 512 ? "YES" : "NO") << "\n";

  if (w != 512 || h != 512) {
    std::cout << "[Diagnostic] ROOT CAUSE: init_image is " << w << "x" << h
              << " but genParams.width/height default to 512x512.\n"
              << "             GGML_ASSERT(image.width == tensor->ne[0]) fires "
              << "because " << w << " != 512.\n"
              << "             FIX: SdModel::process() must set "
                 "genParams.width/height\n"
              << "             from the decoded init_image dimensions.\n";
  }

  EXPECT_GT(w, 0) << "Failed to decode headshot width";
  EXPECT_GT(h, 0) << "Failed to decode headshot height";
}

// ── Synthetic image: dimensions match default (512×512) ─────────────────────
// This test shows that img2img works when the init image dimensions match
// the genParams.width/height that are explicitly passed.

TEST_F(SdImg2ImgTest, Img2Img_512x512_ExplicitDimensions_Succeeds) {
  const int W = 512, H = 512;
  const auto initPng = img2img_helpers::makeSolidPng(W, H, 128, 64, 32);
  ASSERT_FALSE(initPng.empty()) << "Failed to create synthetic PNG";

  const auto [dw, dh] = img2img_helpers::decodeDimensions(initPng);
  std::cout << "\n[Test] Synthetic init image: " << dw << "x" << dh << "\n"
            << "[Test] Passing explicit width=" << W << " height=" << H << "\n";

  std::vector<std::vector<uint8_t>> images;
  std::mutex mu;

  SdModel::GenerationJob job;
  job.paramsJson =
      img2img_helpers::makeImg2ImgParams(initPng, W, H, /*steps=*/1);

  std::cout << "[Test] paramsJson width/height: " << W << " x " << H << "\n"
            << "[Test] init_image width/height: " << dw << " x " << dh << "\n"
            << "[Test] Match: " << (W == dw && H == dh ? "YES ✓" : "NO ✗")
            << "\n";

  job.progressCallback = [](const std::string& json) {
    std::cout << "\r  progress: " << json << std::flush;
  };
  job.outputCallback = [&](const std::vector<uint8_t>& png) {
    std::lock_guard<std::mutex> lk(mu);
    images.push_back(png);
    std::cout << "\n[Test] Output: " << png.size() << " bytes\n";
  };

  EXPECT_NO_THROW(model->process(std::any(job)));
  EXPECT_EQ(images.size(), 1u) << "Expected 1 output image";
  if (!images.empty())
    EXPECT_TRUE(sd_test_helpers::isPng(images[0]))
        << "Output must be valid PNG";
}

// ── Real headshot: auto-detected dimensions
// ─────────────────────────────────── This test verifies the fix:
// genParams.width/height are auto-set from the decoded init_image, so no
// explicit width/height is required.

TEST_F(SdImg2ImgTest, Img2Img_Headshot_AutoDetectedDimensions_Succeeds) {
  const auto path = img2img_helpers::headshotPath();
  if (!std::filesystem::exists(path))
    GTEST_SKIP() << "Headshot not found at: " << path;

  const auto initBytes = img2img_helpers::readFile(path);
  ASSERT_GT(initBytes.size(), 0u);

  const auto [dw, dh] = img2img_helpers::decodeDimensions(initBytes);
  std::cout << "\n[Test] Headshot dimensions: " << dw << "x" << dh << "\n"
            << "[Test] Passing NO explicit width/height — relying on "
               "auto-detect fix\n";

  std::vector<std::vector<uint8_t>> images;
  std::mutex mu;

  SdModel::GenerationJob job;
  // No width/height in params — the fix in SdModel::process() should
  // auto-detect them from the decoded init_image.
  job.paramsJson = img2img_helpers::makeImg2ImgParams(
      initBytes, /*w=*/0, /*h=*/0, /*steps=*/1);

  job.progressCallback = [](const std::string& json) {
    std::cout << "\r  progress: " << json << std::flush;
  };
  job.outputCallback = [&](const std::vector<uint8_t>& png) {
    std::lock_guard<std::mutex> lk(mu);
    images.push_back(png);
    std::cout << "\n[Test] Output: " << png.size() << " bytes\n";

    // Save output
#ifdef PROJECT_ROOT
    const std::string outPath =
        std::string(PROJECT_ROOT) + "/temp/cpp-img2img-headshot-output.png";
    std::ofstream ofs(outPath, std::ios::binary);
    ofs.write(
        reinterpret_cast<const char*>(png.data()),
        static_cast<std::streamsize>(png.size()));
    std::cout << "[Test] Saved → " << outPath << "\n";
#endif
  };

  EXPECT_NO_THROW(model->process(std::any(job)));
  EXPECT_EQ(images.size(), 1u) << "Expected 1 output image";
  if (!images.empty())
    EXPECT_TRUE(sd_test_helpers::isPng(images[0]))
        << "Output must be valid PNG";
}
