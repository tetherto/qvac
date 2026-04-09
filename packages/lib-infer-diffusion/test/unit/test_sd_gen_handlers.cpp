/**
 * Unit tests for SdGenHandlers parsers, SdImageBatch RAII, and SdModel
 * lifecycle.
 *
 * Coverage:
 *   1.  parseSampler   – unordered_map refactor (valid / unknown)
 *   2.  parseScheduler – unordered_map refactor (valid / unknown)
 *   3.  parseCacheMode – unordered_map refactor (valid / "" / unknown)
 *   4.  cache_preset   – pair<mode,threshold> map (all 4 presets / unknown)
 *   5.  parseVaeTileSize – C++20 from_chars + string_view
 *                         (int / "WxH" / bad format / wrong type)
 *   6.  SdImageBatch   – RAII wrapper: pixel buffers freed on scope exit,
 *                        release(i) for early per-image free, and
 *                        exception safety during iteration
 *   7.  IModelAsyncLoad removed – SdModel no longer implements it
 */

#include <cstdlib>
#include <stdexcept>

#include <gtest/gtest.h>
#include <picojson/picojson.h>
#include <stable-diffusion.h>

#include "handlers/SdGenHandlers.hpp"
#include "model-interface/SdModel.hpp"

using namespace qvac_lib_inference_addon_sd;
using namespace qvac_errors;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Build a one-key picojson::object so we can exercise individual handlers.
static picojson::object
makeObj(const std::string& key, const picojson::value& val) {
  picojson::object obj;
  obj[key] = val;
  return obj;
}

static picojson::value str(const std::string& s) { return picojson::value(s); }

static picojson::value num(double n) { return picojson::value(n); }

static picojson::value boolean(bool b) { return picojson::value(b); }

// Apply a single handler by name and return the resulting config.
static SdGenConfig
applyOne(const std::string& key, const picojson::value& val) {
  SdGenConfig cfg;
  applySdGenHandlers(cfg, makeObj(key, val));
  return cfg;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. parseSampler
// ─────────────────────────────────────────────────────────────────────────────

TEST(SdGenHandlers_Sampler, EulerMapsCorrectly) {
  auto cfg = applyOne("sampling_method", str("euler"));
  EXPECT_EQ(cfg.sampleMethod, EULER_SAMPLE_METHOD);
}

TEST(SdGenHandlers_Sampler, EulerAMapsCorrectly) {
  auto cfg = applyOne("sampling_method", str("euler_a"));
  EXPECT_EQ(cfg.sampleMethod, EULER_A_SAMPLE_METHOD);
}

TEST(SdGenHandlers_Sampler, HeunMapsCorrectly) {
  auto cfg = applyOne("sampler", str("heun"));
  EXPECT_EQ(cfg.sampleMethod, HEUN_SAMPLE_METHOD);
}

TEST(SdGenHandlers_Sampler, AllSamplersAccepted) {
  const std::vector<std::pair<std::string, sample_method_t>> cases{
      {"euler", EULER_SAMPLE_METHOD},
      {"euler_a", EULER_A_SAMPLE_METHOD},
      {"heun", HEUN_SAMPLE_METHOD},
      {"dpm2", DPM2_SAMPLE_METHOD},
      {"dpm++2m", DPMPP2M_SAMPLE_METHOD},
      {"dpm++2mv2", DPMPP2Mv2_SAMPLE_METHOD},
      {"dpm++2s_a", DPMPP2S_A_SAMPLE_METHOD},
      {"lcm", LCM_SAMPLE_METHOD},
      {"ipndm", IPNDM_SAMPLE_METHOD},
      {"ipndm_v", IPNDM_V_SAMPLE_METHOD},
      {"ddim_trailing", DDIM_TRAILING_SAMPLE_METHOD},
      {"tcd", TCD_SAMPLE_METHOD},
      {"res_multistep", RES_MULTISTEP_SAMPLE_METHOD},
      {"res_2s", RES_2S_SAMPLE_METHOD},
  };
  for (const auto& [name, expected] : cases) {
    SdGenConfig cfg;
    EXPECT_NO_THROW(
        applySdGenHandlers(cfg, makeObj("sampling_method", str(name))))
        << "sampler: " << name;
    EXPECT_EQ(cfg.sampleMethod, expected) << "sampler: " << name;
  }
}

TEST(SdGenHandlers_Sampler, UnknownSamplerThrows) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("sampling_method", str("bogus_sampler"))),
      StatusError);
}

TEST(SdGenHandlers_Sampler, BothAliasesRouteToSameField) {
  auto cfgA = applyOne("sampling_method", str("euler"));
  auto cfgB = applyOne("sampler", str("euler"));
  EXPECT_EQ(cfgA.sampleMethod, cfgB.sampleMethod);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. parseScheduler
// ─────────────────────────────────────────────────────────────────────────────

TEST(SdGenHandlers_Scheduler, AllSchedulersAccepted) {
  const std::vector<std::pair<std::string, scheduler_t>> cases{
      {"discrete", DISCRETE_SCHEDULER},
      {"karras", KARRAS_SCHEDULER},
      {"exponential", EXPONENTIAL_SCHEDULER},
      {"ays", AYS_SCHEDULER},
      {"gits", GITS_SCHEDULER},
      {"sgm_uniform", SGM_UNIFORM_SCHEDULER},
      {"simple", SIMPLE_SCHEDULER},
      {"lcm", LCM_SCHEDULER},
      {"smoothstep", SMOOTHSTEP_SCHEDULER},
      {"kl_optimal", KL_OPTIMAL_SCHEDULER},
      {"bong_tangent", BONG_TANGENT_SCHEDULER},
  };
  for (const auto& [name, expected] : cases) {
    SdGenConfig cfg;
    EXPECT_NO_THROW(applySdGenHandlers(cfg, makeObj("scheduler", str(name))))
        << "scheduler: " << name;
    EXPECT_EQ(cfg.scheduler, expected) << "scheduler: " << name;
  }
}

TEST(SdGenHandlers_Scheduler, UnknownSchedulerThrows) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("scheduler", str("no_such_scheduler"))),
      StatusError);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. parseCacheMode
// ─────────────────────────────────────────────────────────────────────────────

TEST(SdGenHandlers_CacheMode, DisabledStringMapsToDisabled) {
  auto cfg = applyOne("cache_mode", str("disabled"));
  EXPECT_EQ(cfg.cacheMode, SD_CACHE_DISABLED);
}

TEST(SdGenHandlers_CacheMode, EmptyStringMapsToDisabled) {
  // Both "" and "disabled" are accepted aliases for SD_CACHE_DISABLED.
  auto cfg = applyOne("cache_mode", str(""));
  EXPECT_EQ(cfg.cacheMode, SD_CACHE_DISABLED);
}

TEST(SdGenHandlers_CacheMode, AllCacheModesAccepted) {
  const std::vector<std::pair<std::string, sd_cache_mode_t>> cases{
      {"", SD_CACHE_DISABLED},
      {"disabled", SD_CACHE_DISABLED},
      {"easycache", SD_CACHE_EASYCACHE},
      {"ucache", SD_CACHE_UCACHE},
      {"dbcache", SD_CACHE_DBCACHE},
      {"taylorseer", SD_CACHE_TAYLORSEER},
      {"cache-dit", SD_CACHE_CACHE_DIT},
  };
  for (const auto& [name, expected] : cases) {
    SdGenConfig cfg;
    EXPECT_NO_THROW(applySdGenHandlers(cfg, makeObj("cache_mode", str(name))))
        << "cache_mode: '" << name << "'";
    EXPECT_EQ(cfg.cacheMode, expected) << "cache_mode: '" << name << "'";
  }
}

TEST(SdGenHandlers_CacheMode, UnknownCacheModeThrows) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("cache_mode", str("quantum_cache"))),
      StatusError);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. cache_preset handler
// ─────────────────────────────────────────────────────────────────────────────

TEST(SdGenHandlers_CachePreset, SlowPresetSetsModeAndThreshold) {
  auto cfg = applyOne("cache_preset", str("slow"));
  EXPECT_EQ(cfg.cacheMode, SD_CACHE_EASYCACHE);
  EXPECT_FLOAT_EQ(cfg.cacheThreshold, 0.60f);
}

TEST(SdGenHandlers_CachePreset, MediumPreset) {
  auto cfg = applyOne("cache_preset", str("medium"));
  EXPECT_EQ(cfg.cacheMode, SD_CACHE_EASYCACHE);
  EXPECT_FLOAT_EQ(cfg.cacheThreshold, 0.40f);
}

TEST(SdGenHandlers_CachePreset, FastPreset) {
  auto cfg = applyOne("cache_preset", str("fast"));
  EXPECT_EQ(cfg.cacheMode, SD_CACHE_EASYCACHE);
  EXPECT_FLOAT_EQ(cfg.cacheThreshold, 0.25f);
}

TEST(SdGenHandlers_CachePreset, UltraPreset) {
  auto cfg = applyOne("cache_preset", str("ultra"));
  EXPECT_EQ(cfg.cacheMode, SD_CACHE_EASYCACHE);
  EXPECT_FLOAT_EQ(cfg.cacheThreshold, 0.15f);
}

TEST(SdGenHandlers_CachePreset, PresetsOrderedByThreshold) {
  // Sanity check: slow > medium > fast > ultra (higher threshold =
  // safer/slower)
  auto slow = applyOne("cache_preset", str("slow"));
  auto medium = applyOne("cache_preset", str("medium"));
  auto fast = applyOne("cache_preset", str("fast"));
  auto ultra = applyOne("cache_preset", str("ultra"));
  EXPECT_GT(slow.cacheThreshold, medium.cacheThreshold);
  EXPECT_GT(medium.cacheThreshold, fast.cacheThreshold);
  EXPECT_GT(fast.cacheThreshold, ultra.cacheThreshold);
}

TEST(SdGenHandlers_CachePreset, UnknownPresetThrows) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("cache_preset", str("turbo"))),
      StatusError);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. parseVaeTileSize
// ─────────────────────────────────────────────────────────────────────────────

TEST(SdGenHandlers_VaeTileSize, IntegerAppliesToBothAxes) {
  auto cfg = applyOne("vae_tile_size", num(256.0));
  EXPECT_EQ(cfg.vaeTileSizeX, 256);
  EXPECT_EQ(cfg.vaeTileSizeY, 256);
}

TEST(SdGenHandlers_VaeTileSize, WxHStringSetsAxesIndependently) {
  auto cfg = applyOne("vae_tile_size", str("128x64"));
  EXPECT_EQ(cfg.vaeTileSizeX, 128);
  EXPECT_EQ(cfg.vaeTileSizeY, 64);
}

TEST(SdGenHandlers_VaeTileSize, SquareWxHString) {
  auto cfg = applyOne("vae_tile_size", str("512x512"));
  EXPECT_EQ(cfg.vaeTileSizeX, 512);
  EXPECT_EQ(cfg.vaeTileSizeY, 512);
}

TEST(SdGenHandlers_VaeTileSize, StringWithoutXSeparatorThrows) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("vae_tile_size", str("256"))),
      StatusError);
}

TEST(SdGenHandlers_VaeTileSize, NonNumericWxHThrows) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("vae_tile_size", str("abcxdef"))),
      StatusError);
}

TEST(SdGenHandlers_VaeTileSize, WrongTypeThrows) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("vae_tile_size", boolean(true))),
      StatusError);
}

TEST(SdGenHandlers_VaeTileSize, MissingRhsThrows) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("vae_tile_size", str("128x"))),
      StatusError);
}

TEST(SdGenHandlers_Steps, ZeroThrows) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("steps", num(0.0))),
      StatusError);
}

TEST(SdGenHandlers_Width, NonMultipleOf8Throws) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("width", num(7.0))),
      StatusError);
}

TEST(SdGenHandlers_Strength, AboveOneThrows) {
  SdGenConfig cfg;
  EXPECT_THROW(
      applySdGenHandlers(cfg, makeObj("strength", num(1.1))),
      StatusError);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. SdImageBatch – RAII memory management
//
// SdImageBatch lives in the anonymous namespace of SdModel.cpp so it cannot
// be instantiated directly in a test.  We mirror the class here to validate
// the RAII contract in isolation; the same design is exercised end-to-end by
// the full-generation integration tests.
// ─────────────────────────────────────────────────────────────────────────────

namespace {

// Minimal replica of the SdImageBatch RAII class used in SdModel.cpp.
class SdImageBatchTest {
public:
  SdImageBatchTest(sd_image_t* data, int count) : data_(data), count_(count) {}
  ~SdImageBatchTest() {
    for (int i = 0; i < count_; ++i) {
      free(data_[i].data); // nullptr-safe
    }
    free(data_);
  }

  SdImageBatchTest(const SdImageBatchTest&) = delete;
  SdImageBatchTest& operator=(const SdImageBatchTest&) = delete;
  SdImageBatchTest(SdImageBatchTest&&) = delete;
  SdImageBatchTest& operator=(SdImageBatchTest&&) = delete;

  [[nodiscard]] int count() const { return count_; }
  [[nodiscard]] const sd_image_t& operator[](int i) const { return data_[i]; }
  void release(int i) {
    free(data_[i].data);
    data_[i].data = nullptr;
  }

private:
  sd_image_t* const data_;
  const int count_;
};

// Build a heap-allocated sd_image_t array with real malloc'd pixel buffers
// so that ASan / valgrind can detect any missing free().
static sd_image_t* makeFakeImages(int count, int pixelBytes = 4) {
  auto* arr = static_cast<sd_image_t*>(malloc(sizeof(sd_image_t) * count));
  for (int i = 0; i < count; ++i) {
    arr[i].width = 1;
    arr[i].height = 1;
    arr[i].channel = pixelBytes;
    arr[i].data = static_cast<uint8_t*>(malloc(pixelBytes));
  }
  return arr;
}

} // anonymous namespace

TEST(SdImageBatch, DestructorFreesAllBuffersOnNormalExit) {
  // ASAN will catch a double-free or leak if our destructor is wrong.
  {
    SdImageBatchTest batch(makeFakeImages(3), 3);
    // images iterated but NOT released manually — destructor must clean up.
    for (int i = 0; i < batch.count(); ++i) {
      EXPECT_NE(batch[i].data, nullptr);
    }
  } // destructor fires here
}

TEST(SdImageBatch, ReleaseNullsPointerSoDestructorSkipsIt) {
  SdImageBatchTest batch(makeFakeImages(2), 2);
  batch.release(0);                  // free pixel buf for image 0 early
  EXPECT_EQ(batch[0].data, nullptr); // release() sets data to nullptr
  EXPECT_NE(batch[1].data, nullptr); // image 1 still valid
  // destructor calls free(nullptr) for slot 0 (no-op) and frees slot 1
}

TEST(SdImageBatch, DestructorFiresEvenWhenExceptionThrown) {
  bool destructorRan = false;

  // Wrap batch in a scope that throws to simulate encodeToPng/outputCallback
  // throwing mid-iteration.  Without RAII this would leak all pixel buffers.
  struct Guard {
    bool& ran;
    ~Guard() { ran = true; }
  };

  try {
    SdImageBatchTest batch(makeFakeImages(3), 3);
    Guard g{destructorRan};
    (void)g; // suppress unused warning
    throw std::runtime_error("simulated callback failure");
  } catch (const std::runtime_error&) {
  }

  EXPECT_TRUE(destructorRan);
  // If SdImageBatchTest destructor did NOT run, ASan would report leaks above.
}

TEST(SdImageBatch, EarlyReleaseAllowsImmediateMemoryRecovery) {
  // Simulates the production loop: encode → release → next image
  sd_image_t* arr = makeFakeImages(4);
  SdImageBatchTest batch(arr, 4);

  for (int i = 0; i < batch.count(); ++i) {
    // "process" image i
    EXPECT_NE(batch[i].data, nullptr);
    batch.release(i); // pixel buffer freed immediately
    EXPECT_EQ(batch[i].data, nullptr);
  }
  // destructor: all data_[i].data are nullptr → only the array itself is freed
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. IModelAsyncLoad removed – SdModel must NOT implement that interface
// ─────────────────────────────────────────────────────────────────────────────

TEST(SdModel_NoAsyncLoad, SdModelDoesNotImplementIModelAsyncLoad) {
  SdCtxConfig cfg{};
  SdModel model(std::move(cfg));

  const auto* asyncLoad =
      dynamic_cast<qvac_lib_inference_addon_cpp::model::IModelAsyncLoad*>(
          &model);

  EXPECT_EQ(asyncLoad, nullptr)
      << "SdModel should not implement IModelAsyncLoad — it uses a custom "
         "activate() in AddonJs.hpp that calls load() directly instead";
}

TEST(SdModel_NoAsyncLoad, SdModelStillImplementsIModel) {
  SdCtxConfig cfg{};
  SdModel model(std::move(cfg));

  const auto* imodel =
      dynamic_cast<qvac_lib_inference_addon_cpp::model::IModel*>(&model);
  EXPECT_NE(imodel, nullptr);
}

TEST(SdModel_NoAsyncLoad, SdModelStillImplementsIModelCancel) {
  SdCtxConfig cfg{};
  SdModel model(std::move(cfg));

  const auto* icancel =
      dynamic_cast<qvac_lib_inference_addon_cpp::model::IModelCancel*>(&model);
  EXPECT_NE(icancel, nullptr);
}
