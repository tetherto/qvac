#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <iterator>
#include <stdexcept>
#include <string>
#include <system_error>
#include <vector>

#include <ggml-backend.h>
#include <gtest/gtest.h>

#include "model-interface/FitToFreeDeviceMemory.hpp"

namespace fitmem = fit_to_free_device_memory;

namespace {

/// A model file the fitter could open. The fake invoker never reads it, but
/// `fitParamsToFreeDeviceMemory` refuses to run without one: at the pinned
/// fabric an unreadable path is reported as `COMMON_PARAMS_FIT_STATUS_ERROR`
/// rather than crashing, and the guard turns that into a specific warning and a
/// skipped descent search.
class ReadableModelFile {
public:
  ReadableModelFile() {
    path_ = (std::filesystem::temp_directory_path() /
             "qvac-fit-to-free-device-memory.gguf")
                .string();
    FILE* handle = std::fopen(path_.c_str(), "wb");
    if (handle != nullptr) {
      std::fputs("GGUF", handle);
      std::fclose(handle);
    }
  }
  ReadableModelFile(const ReadableModelFile&) = delete;
  ReadableModelFile& operator=(const ReadableModelFile&) = delete;
  ReadableModelFile(ReadableModelFile&&) = delete;
  ReadableModelFile& operator=(ReadableModelFile&&) = delete;
  ~ReadableModelFile() {
    std::error_code ignored;
    std::filesystem::remove(path_, ignored);
  }

  const std::string& path() const { return path_; }

private:
  std::string path_;
};

/// What the fitter was handed, captured so the tests can assert on the
/// preconditions fabric checks before it will run at all.
struct InvocationRecord {
  int calls = 0;
  bool tensorSplitWasNull = true;
  bool buftOverridesWasNull = true;
  bool marginsWasNull = true;
  llama_model_tensor_buft_override firstOverrideSeen{nullptr, nullptr};
  int32_t nGpuLayersSeen = 0;
  uint32_t nCtxMinSeen = 0;
};

/// Writes a placement the way the real fitter does on its way to `status`, so a
/// non-SUCCESS case leaves exactly the debris the production code has to not
/// adopt. `common_fit_params` writes into these buffers on every probe of its
/// descent search and restores only the two parameter structs when it gives up.
fitmem::LlamaFitInvoker recordingInvoker(
    InvocationRecord& record, common_params_fit_status status,
    const char* placementPattern = "blk\\.[0-9]+\\.ffn_.*_exps") {
  return [&record, status, placementPattern](
             const char*,
             llama_model_params* mparams,
             llama_context_params* cparams,
             float* tensorSplit,
             llama_model_tensor_buft_override* buftOverrides,
             size_t* margins,
             uint32_t nCtxMin,
             bool,
             ggml_log_level) {
    record.calls++;
    record.tensorSplitWasNull = tensorSplit == nullptr;
    record.buftOverridesWasNull = buftOverrides == nullptr;
    record.marginsWasNull = margins == nullptr;
    record.nGpuLayersSeen = mparams->n_gpu_layers;
    record.nCtxMinSeen = nCtxMin;
    if (buftOverrides != nullptr) {
      record.firstOverrideSeen = buftOverrides[0];
      buftOverrides[0] = {placementPattern, ggml_backend_cpu_buffer_type()};
      buftOverrides[1] = {nullptr, nullptr};
    }
    if (tensorSplit != nullptr) {
      // Several entries, not just [0]: the fold-back copies the whole array, so
      // a wrong length or an off-by-one on the seed slice has to be visible.
      tensorSplit[0] = 0.25F;
      tensorSplit[1] = 0.5F;
      tensorSplit[2] = 0.25F;
    }
    mparams->n_gpu_layers = 11;
    cparams->n_ctx = 2048;
    // The other two fields the fitter can move. Without sentinels here the
    // fold-back lines carrying them never run against a value that
    // distinguishes a correct copy from a missing one.
    cparams->prefetch_weights = true;
    cparams->moe_cache_size = 7340032; // 7 MiB
    return status;
  };
}

common_params fitEnabledParams() {
  common_params params;
  params.fit_params = true;
  return params;
}

} // namespace

TEST(FitToFreeDeviceMemoryTest, SkippedWhenFitParamsDisabled) {
  const ReadableModelFile model;
  InvocationRecord record;
  common_params params = fitEnabledParams();
  // What QVAC-24253 does for `split-mode: tensor`, where fabric cannot fit.
  params.fit_params = false;

  const auto outcome = fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      recordingInvoker(record, COMMON_PARAMS_FIT_STATUS_SUCCESS));

  EXPECT_EQ(record.calls, 0);
  EXPECT_FALSE(outcome.invoked);
  EXPECT_FALSE(outcome.applied);
}

TEST(FitToFreeDeviceMemoryTest, SkippedWhenModelFileIsNotReadable) {
  InvocationRecord record;
  common_params params = fitEnabledParams();

  const auto outcome = fitmem::fitParamsToFreeDeviceMemory(
      params,
      "/nonexistent/qvac-fit-to-free-device-memory.gguf",
      recordingInvoker(record, COMMON_PARAMS_FIT_STATUS_SUCCESS));

  EXPECT_EQ(record.calls, 0);
  EXPECT_FALSE(outcome.invoked);
  EXPECT_FALSE(outcome.applied);
}

TEST(FitToFreeDeviceMemoryTest, SkippedWhenModelPathIsEmpty) {
  InvocationRecord record;
  common_params params = fitEnabledParams();

  const auto outcome = fitmem::fitParamsToFreeDeviceMemory(
      params, "", recordingInvoker(record, COMMON_PARAMS_FIT_STATUS_SUCCESS));

  EXPECT_EQ(record.calls, 0);
  EXPECT_FALSE(outcome.invoked);
}

// The three preconditions common_fit_params checks before it will do anything:
// a writable tensor_split, a writable tensor_buft_overrides, and a first
// override entry the user has not already set. Failing the second is what made
// every load abort with "did not provide buffer to set tensor_buft_overrides".
TEST(FitToFreeDeviceMemoryTest, FitterReceivesWritableBuffers) {
  const ReadableModelFile model;
  InvocationRecord record;
  common_params params = fitEnabledParams();
  params.fit_params_min_ctx = 4096;

  fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      recordingInvoker(record, COMMON_PARAMS_FIT_STATUS_SUCCESS));

  ASSERT_EQ(record.calls, 1);
  EXPECT_FALSE(record.tensorSplitWasNull);
  EXPECT_FALSE(record.buftOverridesWasNull);
  EXPECT_FALSE(record.marginsWasNull);
  EXPECT_EQ(record.firstOverrideSeen.pattern, nullptr);
  EXPECT_EQ(record.firstOverrideSeen.buft, nullptr);
  EXPECT_EQ(record.nCtxMinSeen, 4096U);
}

TEST(FitToFreeDeviceMemoryTest, SuccessIsFoldedBackIntoParams) {
  const ReadableModelFile model;
  InvocationRecord record;
  common_params params = fitEnabledParams();

  const auto outcome = fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      recordingInvoker(record, COMMON_PARAMS_FIT_STATUS_SUCCESS));

  ASSERT_EQ(record.calls, 1);
  EXPECT_TRUE(outcome.invoked);
  EXPECT_TRUE(outcome.applied);
  EXPECT_EQ(params.n_gpu_layers, 11);
  EXPECT_EQ(params.n_ctx, 2048);
  // All six fields the fitter can move, so none of the fold-back lines is
  // carried by an untested assumption.
  EXPECT_TRUE(params.prefetch_weights);
  EXPECT_EQ(params.moe_cache_size, 7340032U);
  EXPECT_FLOAT_EQ(params.tensor_split[0], 0.25F);
  EXPECT_FLOAT_EQ(params.tensor_split[1], 0.5F);
  EXPECT_FLOAT_EQ(params.tensor_split[2], 0.25F);
  // Copied only as far as the terminator, so the unused tail of the 4096-entry
  // scratch never reaches `params`.
  ASSERT_EQ(params.tensor_buft_overrides.size(), 2U);
  EXPECT_STREQ(
      params.tensor_buft_overrides[0].pattern, "blk\\.[0-9]+\\.ffn_.*_exps");
  EXPECT_EQ(params.tensor_buft_overrides[1].pattern, nullptr);
}

// The scratch is as wide as the array fabric writes through, not as wide as
// `llama_max_devices()`: fabric writes one entry per registered device and
// nothing truncates that to the 16-device cap.
TEST(FitToFreeDeviceMemoryTest, TensorSplitScratchSpansTheWholeArray) {
  const ReadableModelFile model;
  common_params params = fitEnabledParams();
  size_t widthSeen = 0;

  fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      [&widthSeen](
          const char*,
          llama_model_params*,
          llama_context_params*,
          float* tensorSplit,
          llama_model_tensor_buft_override* buftOverrides,
          size_t*,
          uint32_t,
          bool,
          ggml_log_level) {
        // Write the last slot the production buffer must own. A narrower
        // scratch would make this a heap overflow rather than a pass.
        widthSeen = std::size(common_params{}.tensor_split);
        tensorSplit[widthSeen - 1] = 1.0F;
        buftOverrides[0] = {nullptr, nullptr};
        return COMMON_PARAMS_FIT_STATUS_SUCCESS;
      });

  ASSERT_GT(widthSeen, llama_max_devices());
  EXPECT_FLOAT_EQ(params.tensor_split[widthSeen - 1], 1.0F);
}

// The other array fabric indexes by registered-device id, and for the same
// reason: `fit_params_target` is only `llama_max_devices()` wide, while fabric
// reads `margins[id]` for every registered device with no clamp to that cap.
TEST(FitToFreeDeviceMemoryTest, MarginsScratchIsAsWideAsTheTensorSplitScratch) {
  const ReadableModelFile model;
  common_params params = fitEnabledParams();
  const size_t width = std::size(common_params{}.tensor_split);
  ASSERT_GT(width, params.fit_params_target.size());
  size_t lastMarginSeen = 0;

  fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      [width, &lastMarginSeen](
          const char*,
          llama_model_params*,
          llama_context_params*,
          float*,
          llama_model_tensor_buft_override* buftOverrides,
          size_t* margins,
          uint32_t,
          bool,
          ggml_log_level) {
        // Reading the slot past the end of `fit_params_target` is the over-read
        // under test; writing it proves the buffer is the helper's own.
        margins[width - 1] = 4096;
        lastMarginSeen = margins[width - 1];
        buftOverrides[0] = {nullptr, nullptr};
        return COMMON_PARAMS_FIT_STATUS_SUCCESS;
      });

  EXPECT_EQ(lastMarginSeen, 4096U);
  // The scratch is the helper's, so the caller's targets are not rewritten.
  EXPECT_EQ(params.fit_params_target.size(), llama_max_devices());
}

// Fabric's two "no changes needed" early returns report SUCCESS having written
// nothing. Nothing may be adopted from that — including the one-entry
// `{nullptr, nullptr}` the terminator search would otherwise find at index 0 of
// the zeroed scratch — and the log must not claim a placement was applied.
TEST(FitToFreeDeviceMemoryTest, NoOpSuccessChangesNothing) {
  const ReadableModelFile model;
  common_params params = fitEnabledParams();
  const int32_t gpuLayersBefore = params.n_gpu_layers;
  const int32_t nCtxBefore = params.n_ctx;

  const auto outcome = fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      [](const char*,
         llama_model_params*,
         llama_context_params*,
         float*,
         llama_model_tensor_buft_override*,
         size_t*,
         uint32_t,
         bool,
         ggml_log_level) { return COMMON_PARAMS_FIT_STATUS_SUCCESS; });

  EXPECT_TRUE(outcome.invoked);
  EXPECT_EQ(outcome.status, COMMON_PARAMS_FIT_STATUS_SUCCESS);
  // SUCCESS, but nothing moved — so not "applied".
  EXPECT_FALSE(outcome.applied);
  EXPECT_EQ(params.n_gpu_layers, gpuLayersBefore);
  EXPECT_EQ(params.n_ctx, nCtxBefore);
  EXPECT_TRUE(params.tensor_buft_overrides.empty());
}

// A caller list long enough to fill the scratch would have its terminator
// truncated away by the seed copy, and the unterminated array then goes to a C
// API. Fabric rejects a caller-set override list before it reads that far, but
// that is fabric's invariant rather than this file's.
TEST(FitToFreeDeviceMemoryTest, OverlongCallerOverridesStayTerminated) {
  const ReadableModelFile model;
  common_params params = fitEnabledParams();
  static constexpr const char* kCallerPattern = "blk\\..*\\.ffn_up_exps";
  params.tensor_buft_overrides.assign(
      llama_max_tensor_buft_overrides() + 8,
      {kCallerPattern, ggml_backend_cpu_buffer_type()});
  params.tensor_buft_overrides.back() = {nullptr, nullptr};
  bool lastScratchEntryWasTerminator = false;

  fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      [&lastScratchEntryWasTerminator](
          const char*,
          llama_model_params*,
          llama_context_params*,
          float*,
          llama_model_tensor_buft_override* buftOverrides,
          size_t*,
          uint32_t,
          bool,
          ggml_log_level) {
        const auto& last = buftOverrides[llama_max_tensor_buft_overrides() - 1];
        lastScratchEntryWasTerminator =
            last.pattern == nullptr && last.buft == nullptr;
        return COMMON_PARAMS_FIT_STATUS_FAILURE;
      });

  EXPECT_TRUE(lastScratchEntryWasTerminator);
}

// An invoker that returns SUCCESS without terminating the override list would,
// if adopted, trip common_model_params_to_llama's GGML_ASSERT and abort the
// process. Decline instead.
TEST(FitToFreeDeviceMemoryTest, UnterminatedFitResultIsNotAdopted) {
  const ReadableModelFile model;
  common_params params = fitEnabledParams();
  const int32_t gpuLayersBefore = params.n_gpu_layers;

  const auto outcome = fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      [](const char*,
         llama_model_params* mparams,
         llama_context_params*,
         float*,
         llama_model_tensor_buft_override* buftOverrides,
         size_t*,
         uint32_t,
         bool,
         ggml_log_level) {
        for (size_t index = 0; index < llama_max_tensor_buft_overrides();
             ++index) {
          buftOverrides[index] = {
              "blk\\.0\\.ffn_up_exps", ggml_backend_cpu_buffer_type()};
        }
        mparams->n_gpu_layers = 11;
        return COMMON_PARAMS_FIT_STATUS_SUCCESS;
      });

  EXPECT_TRUE(outcome.invoked);
  EXPECT_FALSE(outcome.applied);
  EXPECT_EQ(params.n_gpu_layers, gpuLayersBefore);
  EXPECT_TRUE(params.tensor_buft_overrides.empty());
}

// The regression this whole helper exists for. common_fit_params restores the
// two parameter structs on FAILURE but not the buffers they point at, and it
// has already written a candidate placement into them — so a fit that fails
// mid-descent used to hand the load a placement the fitter had just rejected,
// up to and including every MoE expert pinned to CPU.
TEST(FitToFreeDeviceMemoryTest, FailureLeavesParamsUntouched) {
  const ReadableModelFile model;
  InvocationRecord record;
  common_params params = fitEnabledParams();
  const int32_t gpuLayersBefore = params.n_gpu_layers;
  const int32_t nCtxBefore = params.n_ctx;
  const float tensorSplitBefore = params.tensor_split[0];

  const auto outcome = fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      recordingInvoker(record, COMMON_PARAMS_FIT_STATUS_FAILURE));

  ASSERT_EQ(record.calls, 1);
  EXPECT_TRUE(outcome.invoked);
  EXPECT_FALSE(outcome.applied);
  EXPECT_EQ(params.n_gpu_layers, gpuLayersBefore);
  EXPECT_EQ(params.n_ctx, nCtxBefore);
  EXPECT_FLOAT_EQ(params.tensor_split[0], tensorSplitBefore);
  EXPECT_TRUE(params.tensor_buft_overrides.empty());
}

TEST(FitToFreeDeviceMemoryTest, ErrorLeavesParamsUntouched) {
  const ReadableModelFile model;
  InvocationRecord record;
  common_params params = fitEnabledParams();
  const int32_t gpuLayersBefore = params.n_gpu_layers;

  const auto outcome = fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      recordingInvoker(record, COMMON_PARAMS_FIT_STATUS_ERROR));

  ASSERT_EQ(record.calls, 1);
  EXPECT_TRUE(outcome.invoked);
  EXPECT_FALSE(outcome.applied);
  EXPECT_EQ(outcome.status, COMMON_PARAMS_FIT_STATUS_ERROR);
  EXPECT_EQ(params.n_gpu_layers, gpuLayersBefore);
  EXPECT_TRUE(params.tensor_buft_overrides.empty());
}

// A caller-supplied override pins the placement: fabric aborts the fit rather
// than touch it. The override has to survive that abort intact, or the load
// silently drops what the caller configured.
TEST(FitToFreeDeviceMemoryTest, CallerOverridesSurviveAFailedFit) {
  const ReadableModelFile model;
  InvocationRecord record;
  common_params params = fitEnabledParams();
  static constexpr const char* kCallerPattern = "blk\\..*\\.ffn_up_exps";
  params.tensor_buft_overrides.push_back(
      {kCallerPattern, ggml_backend_cpu_buffer_type()});
  params.tensor_buft_overrides.push_back({nullptr, nullptr});

  fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      recordingInvoker(record, COMMON_PARAMS_FIT_STATUS_FAILURE));

  ASSERT_EQ(record.calls, 1);
  // The fitter saw the caller's override, which is what makes it abort.
  EXPECT_STREQ(record.firstOverrideSeen.pattern, kCallerPattern);
  ASSERT_EQ(params.tensor_buft_overrides.size(), 2U);
  EXPECT_STREQ(params.tensor_buft_overrides[0].pattern, kCallerPattern);
  EXPECT_EQ(params.tensor_buft_overrides[1].pattern, nullptr);
}

TEST(FitToFreeDeviceMemoryTest, UnterminatedCallerOverridesAreTerminated) {
  const ReadableModelFile model;
  InvocationRecord record;
  common_params params = fitEnabledParams();
  // No terminator. common_model_params_to_llama GGML_ASSERTs on this and would
  // abort the process, so the helper has to normalise it first.
  params.tensor_buft_overrides.push_back(
      {"blk\\..*\\.ffn_down_exps", ggml_backend_cpu_buffer_type()});

  fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      recordingInvoker(record, COMMON_PARAMS_FIT_STATUS_FAILURE));

  ASSERT_EQ(record.calls, 1);
  ASSERT_GE(params.tensor_buft_overrides.size(), 2U);
  EXPECT_EQ(params.tensor_buft_overrides.back().pattern, nullptr);
}

// The fitter installs a pointer to one of its own stack frames as the
// process-global log user_data and its restore is not exception safe. This
// addon installs a global callback of its own, exactly once per process behind
// a `g_initialized` early return, so anything left behind would send every
// later log line from every live model through a freed frame — and nothing
// re-installs it.
//
// The same reason this test has to put back whatever was installed on entry
// rather than resetting to llama's default: every test that runs after it in
// this binary would otherwise lose the addon's log routing, including
// `OrdinaryLoadReachesTheAutomaticPlacement`, which asserts on captured log
// output.
class FitLoggerRestoreTest : public ::testing::Test {
protected:
  void SetUp() override { llama_log_get(&entryCallback_, &entryUserData_); }
  void TearDown() override { llama_log_set(entryCallback_, entryUserData_); }

private:
  ggml_log_callback entryCallback_ = nullptr;
  void* entryUserData_ = nullptr;
};

TEST_F(FitLoggerRestoreTest, LogCallbackIsRestoredOnReturn) {
  const ReadableModelFile model;
  common_params params = fitEnabledParams();

  const auto sentinel = [](ggml_log_level, const char*, void*) {};
  int sentinelUserData = 0;
  llama_log_set(sentinel, &sentinelUserData);

  fitmem::fitParamsToFreeDeviceMemory(
      params,
      model.path(),
      [](const char*,
         llama_model_params*,
         llama_context_params*,
         float*,
         llama_model_tensor_buft_override*,
         size_t*,
         uint32_t,
         bool,
         ggml_log_level) {
        // What the fitter does to the global logger and then restores.
        llama_log_set(nullptr, nullptr);
        return COMMON_PARAMS_FIT_STATUS_FAILURE;
      });

  ggml_log_callback restoredCallback = nullptr;
  void* restoredUserData = nullptr;
  llama_log_get(&restoredCallback, &restoredUserData);
  EXPECT_EQ(restoredUserData, &sentinelUserData);
  EXPECT_NE(restoredCallback, nullptr);
}

// The path the production restore was originally missing: fabric's own restore
// is skipped when it throws, and a straight-line `llama_log_set` after the call
// would be skipped too. Only an exception escaping the *invoker* reaches this —
// `common_fit_params` catches everything derived from `std::exception`, so in
// production this is the empty-seam / alternate-invoker case.
TEST_F(FitLoggerRestoreTest, LogCallbackIsRestoredWhenTheInvokerThrows) {
  const ReadableModelFile model;
  common_params params = fitEnabledParams();

  const auto sentinel = [](ggml_log_level, const char*, void*) {};
  int sentinelUserData = 0;
  llama_log_set(sentinel, &sentinelUserData);

  EXPECT_THROW(
      {
        fitmem::fitParamsToFreeDeviceMemory(
            params,
            model.path(),
            [](const char*,
               llama_model_params*,
               llama_context_params*,
               float*,
               llama_model_tensor_buft_override*,
               size_t*,
               uint32_t,
               bool,
               ggml_log_level) -> common_params_fit_status {
              llama_log_set(nullptr, nullptr);
              throw std::runtime_error("invoker failed mid-fit");
            });
      },
      std::runtime_error);

  ggml_log_callback restoredCallback = nullptr;
  void* restoredUserData = nullptr;
  llama_log_get(&restoredCallback, &restoredUserData);
  EXPECT_EQ(restoredUserData, &sentinelUserData)
      << "an exception escaping the fitter left its logger installed";
  EXPECT_NE(restoredCallback, nullptr);
}
