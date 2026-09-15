#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <string>
#include <system_error>
#include <vector>

#include <ggml-backend.h>
#include <gtest/gtest.h>

#include "model-interface/FitToFreeDeviceMemory.hpp"

namespace fitmem = fit_to_free_device_memory;

namespace {

/// A model file the fitter could open. The fake invoker never reads it, but
/// `fitParamsToFreeDeviceMemory` refuses to run without one —
/// `common_fit_params` segfaults on a path it cannot open, so the guard is
/// load-bearing.
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
      tensorSplit[0] = 0.25F;
    }
    mparams->n_gpu_layers = 11;
    cparams->n_ctx = 2048;
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
  EXPECT_FLOAT_EQ(params.tensor_split[0], 0.25F);
  // Copied only as far as the terminator, so the unused tail of the 4096-entry
  // scratch never reaches `params`.
  ASSERT_EQ(params.tensor_buft_overrides.size(), 2U);
  EXPECT_STREQ(
      params.tensor_buft_overrides[0].pattern, "blk\\.[0-9]+\\.ffn_.*_exps");
  EXPECT_EQ(params.tensor_buft_overrides[1].pattern, nullptr);
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
// addon installs a global callback of its own, so anything left behind would
// send every later log line from every live model through a freed frame.
TEST(FitToFreeDeviceMemoryTest, LogCallbackIsRestored) {
  const ReadableModelFile model;
  common_params params = fitEnabledParams();

  static int sentinelCalls = 0;
  sentinelCalls = 0;
  const auto sentinel = [](ggml_log_level, const char*, void*) {
    sentinelCalls++;
  };
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
        // What the fitter does and then fails to undo when it throws.
        llama_log_set(nullptr, nullptr);
        return COMMON_PARAMS_FIT_STATUS_FAILURE;
      });

  ggml_log_callback restoredCallback = nullptr;
  void* restoredUserData = nullptr;
  llama_log_get(&restoredCallback, &restoredUserData);
  EXPECT_EQ(restoredUserData, &sentinelUserData);
  EXPECT_NE(restoredCallback, nullptr);

  llama_log_set(nullptr, nullptr);
}
