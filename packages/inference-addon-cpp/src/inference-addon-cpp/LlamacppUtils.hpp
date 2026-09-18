#pragma once

#include <algorithm>
#include <filesystem>
#include <iostream>
#include <limits>
#include <mutex>
#include <ranges>
#include <streambuf>
#include <system_error>
#include <utility>
#include <vector>

#include <llama-cpp.h>
#include <inference-addon-cpp/Errors.hpp>

#include "GGUFShards.hpp"
#include "common/common.h"
#include "common/fit.h"
#include "common/log.h"

/// @brief Drops the unused tail of `params.tensor_buft_overrides`, keeping the
/// overrides in force and the null entry that terminates them.
/// @note The fitter needs `llama_max_tensor_buft_overrides()` writable entries
/// while it runs, but the loader reads only up to the terminator, and `params`
/// outlives the load: it is copied by value into each per-slot context and kept
/// for the model's lifetime. Trimming keeps that copy proportional to the
/// overrides actually in use. Safe to call on an already-trimmed or empty
/// vector, and on one that was never padded.
inline void trimTensorBuftOverridesAfterFit(common_params& params) {
  const auto terminator = std::ranges::find_if(
      params.tensor_buft_overrides,
      [](const llama_model_tensor_buft_override& candidate) {
        return candidate.pattern == nullptr;
      });
  if (terminator == params.tensor_buft_overrides.end()) {
    return;
  }
  params.tensor_buft_overrides.erase(
      terminator + 1, params.tensor_buft_overrides.end());
}

/// @brief Pads `params.tensor_buft_overrides` up to the buffer size
/// `common_fit_params` writes its placement into.
/// @note This mirrors the padding qvac-fabric's own `common_params_parse` does
/// (common/arg.cpp). Without it the vector stays empty for a caller that set no
/// override of its own, `common_model_params_to_llama` maps an empty vector to
/// a null `tensor_buft_overrides` pointer, and the fitter aborts with "did not
/// provide buffer to set tensor_buft_overrides" — leaving the model to load
/// with every layer on the GPU. Every padding entry is a null one, so the first
/// of them still terminates whatever overrides the caller did set, and
/// re-running the padding is a no-op.
/// @note For consumers that call `common_init_from_params` directly and so have
/// to satisfy the fitter's buffer requirement themselves; the loaders in this
/// header go through `fitParamsToFreeDeviceMemory` instead, which fits against
/// scratch buffers and needs no padding. Pair it with
/// `trimTensorBuftOverridesAfterFit` once the fit has run: the padded vector is
/// ~64 KiB, and `params` is copied by value into every per-slot context, so
/// leaving it padded multiplies that by the slot count.
inline void padTensorBuftOverridesForFit(common_params& params) {
  const size_t maxOverrides = llama_max_tensor_buft_overrides();
  // Anything past the caller's own terminator is unreachable for the loader and
  // only eats into the space the fitter needs, so drop it first. Doing this up
  // front is also what keeps padding idempotent: a second call trims the pad
  // back to its lone terminator and then rebuilds it identically.
  trimTensorBuftOverridesAfterFit(params);
  if (params.tensor_buft_overrides.size() >= maxOverrides) {
    // Only reachable with at least `maxOverrides` overrides and no terminator
    // among them — not from either in-repo consumer. Handled rather than
    // ignored because the alternative is a process abort: the list has to end
    // in a null entry for `common_model_params_to_llama`'s GGML_ASSERT, and
    // there is no room left to add one without giving up an override.
    LOG_WRN(
        "%s: %zu tensor buffer overrides is at or past the %zu the loader "
        "accepts, and none of them terminates the list; dropping the last %zu "
        "to make room for a terminator\n",
        __func__,
        params.tensor_buft_overrides.size(),
        maxOverrides,
        params.tensor_buft_overrides.size() - (maxOverrides - 1));
    params.tensor_buft_overrides.resize(maxOverrides);
    params.tensor_buft_overrides.back() = {nullptr, nullptr};
    return;
  }
  while (params.tensor_buft_overrides.size() < maxOverrides) {
    params.tensor_buft_overrides.push_back({nullptr, nullptr});
  }
}

/// @brief Runs qvac-fabric's automatic GPU/CPU placement (`--fit`) for a model
/// that is loaded outside `common_init_from_params`, and folds the result back
/// into @p params.
/// @param params Load configuration; updated in place on a successful fit.
/// @param fitModelPath GGUF the fitter reads the model shape from. For a
/// sharded model this is the first shard — llama's loader walks the rest of the
/// split set from its metadata.
/// @note Nothing is written to @p params unless the fit succeeds, so a fit that
/// fails or errors leaves the load to proceed with exactly the configuration
/// the caller asked for. This is the one place the fit should run: every loader
/// in this header routes through it, and `initFromConfig` clears
/// `params.fit_params` across its `common_init_from_params` call — restoring it
/// afterwards — so fabric does not fit a second time in place, against @p
/// params' own buffers and discarding the status.
/// @note All six fields the fitter can move — `n_gpu_layers`, `n_ctx`,
/// `prefetch_weights`, `moe_cache_size`, `tensor_split` and
/// `tensor_buft_overrides` — carry its decision afterwards, on every path.
/// The write-back is not optional for the shard loaders: they hand @p params —
/// not the fitted locals — to `common_init_from_model_and_params`, which
/// rebuilds the context parameters from scratch, so without it the weights
/// would land where the fit put them while the context was created at the size
/// it had just rejected.
/// @note @p params.tensor_buft_overrides must be null-terminated if non-empty,
/// the same precondition `common_model_params_to_llama` asserts; an
/// unterminated list is terminated here rather than left to abort the process.
inline void fitParamsToFreeDeviceMemory(
    common_params& params, const std::string& fitModelPath) {
  if (!params.fit_params) {
    return;
  }
  // The `error_code` overload, not the throwing one: the single-argument form
  // throws `filesystem_error` on e.g. EACCES on a parent directory, which would
  // leave the addon through `initFromConfig` as an unmapped exception instead
  // of a `qvac_errors::StatusError`. A false return is handled the same either
  // way.
  std::error_code existsError;
  if (fitModelPath.empty() ||
      !std::filesystem::exists(fitModelPath, existsError)) {
    LOG_WRN(
        "%s: skipping automatic placement: no model file to read at '%s'\n",
        __func__,
        fitModelPath.c_str());
    return;
  }

  // `common/fit.h`: `common_fit_params` "is NOT thread safe because it modifies
  // the global llama logger state" — it installs a pointer to one of its own
  // stack frames as the process-global log user_data for the duration of the
  // call. Mirrors `g_fitMutex` in
  // packages/model-fit/addon/src/fit/FitParams.cpp, which guards the identical
  // call for the identical reason; that mutex is private to the model-fit
  // module and cannot cover this call site.
  static std::mutex fitMutex;
  const std::lock_guard<std::mutex> fitLock(fitMutex);

  // `common_model_params_to_llama` asserts a non-empty override list ends in a
  // null entry and aborts the process otherwise. Normalise rather than let a
  // caller's unterminated list take the process down — this used to happen as a
  // side effect of padding here, which the scratch buffers replaced.
  if (!params.tensor_buft_overrides.empty() &&
      params.tensor_buft_overrides.back().pattern != nullptr) {
    params.tensor_buft_overrides.push_back({nullptr, nullptr});
  }

  llama_model_params mparams = common_model_params_to_llama(params);
  llama_context_params cparams = common_context_params_to_llama(params);

  // Fit into scratch buffers rather than the `params`-owned ones, the way
  // packages/model-fit/addon/src/fit/LlamaLoadConfig.cpp does. The fitter
  // writes its candidate placement into these on every probe of its descent
  // search, not only on the one it settles on, and when it gives up it restores
  // the two structs but not the buffers they point at — so fitting in place
  // would leave a rejected placement in `params` for the load below to pick up.
  // Seeded from `params` so that a field the fitter never writes (tensor_split
  // when there is only one device) still round-trips the caller's value.
  std::vector<float> tensorSplit(
      std::begin(params.tensor_split),
      std::begin(params.tensor_split) + llama_max_devices());
  std::vector<llama_model_tensor_buft_override> buftOverrides(
      llama_max_tensor_buft_overrides());
  std::copy_n(
      params.tensor_buft_overrides.begin(),
      std::min(params.tensor_buft_overrides.size(), buftOverrides.size()),
      buftOverrides.begin());

  // The fitter installs a pointer to one of its own stack frames as the
  // process-global ggml log user_data and restores it on the way out — but the
  // restore is not exception-safe: `fit.cpp` throws from inside that window (a
  // missing CPU backend at :102, among others), and the handler in
  // `common_fit_params` maps those to a status rather than putting the logger
  // back. Reinstating what we captured makes that unconditional, so the load
  // below can never log through a freed frame. A no-op when the fitter did
  // restore it.
  ggml_log_callback priorLogCallback = nullptr;
  void* priorLogUserData = nullptr;
  llama_log_get(&priorLogCallback, &priorLogUserData);

  const common_params_fit_status status = common_fit_params(
      fitModelPath.c_str(),
      &mparams,
      &cparams,
      tensorSplit.data(),
      buftOverrides.data(),
      params.fit_params_target.data(),
      params.fit_params_min_ctx,
      params.prefetch_weights_auto,
      params.verbosity >= LOG_LEVEL_DEBUG ? GGML_LOG_LEVEL_DEBUG
                                          : GGML_LOG_LEVEL_ERROR);

  llama_log_set(priorLogCallback, priorLogUserData);

  if (status != COMMON_PARAMS_FIT_STATUS_SUCCESS) {
    // FAILURE means "no placement fits", which the caller's own configuration
    // is the right thing to fall back to, and the fitter has already logged it.
    // ERROR is an internal fault — nothing it produced is trustworthy — so say
    // so rather than let it pass as quietly as a routine "does not fit".
    if (status == COMMON_PARAMS_FIT_STATUS_ERROR) {
      LOG_ERR(
          "%s: automatic placement hit an internal error; loading '%s' as "
          "requested instead\n",
          __func__,
          fitModelPath.c_str());
    }
    return;
  }

  params.n_gpu_layers = mparams.n_gpu_layers;
  // `n_ctx` is uint32_t here and int32_t in common_params. The fitter cannot
  // currently produce a value this clamps — it only ever lowers n_ctx, and only
  // towards a trained context that already fits — so this is a guard against a
  // future change to its bounds, not a live narrowing bug.
  params.n_ctx = static_cast<int32_t>(std::min<uint32_t>(
      cparams.n_ctx,
      static_cast<uint32_t>(std::numeric_limits<int32_t>::max())));
  params.prefetch_weights = cparams.prefetch_weights;
  params.moe_cache_size = cparams.moe_cache_size;

  // Adopted only here, so a placement the fitter probed and rejected never
  // reaches the load. Copying only as far as the terminator keeps the unused
  // tail of the scratch out of `params`, which is copied by value into every
  // per-slot context and kept for the model's lifetime.
  std::copy(
      tensorSplit.begin(), tensorSplit.end(), std::begin(params.tensor_split));
  const auto terminator = std::ranges::find_if(
      buftOverrides, [](const llama_model_tensor_buft_override& candidate) {
        return candidate.pattern == nullptr;
      });
  params.tensor_buft_overrides.assign(
      buftOverrides.begin(),
      terminator == buftOverrides.end() ? terminator : terminator + 1);
}

/// @note async version
inline common_init_result_ptr initFromShards(
    const GGUFShards& shards, common_params& params,
    const std::string& loadingContext) {
  LOG_INF(
      "%s: load the model from async shards and apply lora adapter, if any.\n",
      __func__);
  llama_model_params mparams = common_model_params_to_llama(params);
  auto pathsView =
      shards.gguf_files |
      std::views::transform([](const std::string& str) { return str.c_str(); });
  std::vector<const char*> pathsVec(pathsView.begin(), pathsView.end());
  llama_model* model = llama_model_load_from_split_futures(
      pathsVec.data(),
      pathsVec.size(),
      loadingContext.c_str(),
      shards.tensors_file.c_str(),
      mparams);
  return common_init_from_model_and_params(model, params);
}

/// @note from disk
inline common_init_result_ptr
initFromShards(const GGUFShards& shards, common_params& params) {
  LOG_INF(
      "%s: load the model from disk shards and apply lora adapter, if any.\n",
      __func__);
  // `llama_model_load_from_splits` bypasses `common_init_from_params`, which is
  // the only place fabric runs its automatic placement, so a sharded model
  // would otherwise never be fitted: every layer goes to the GPU and the driver
  // spills whatever does not fit back to host memory.
  if (!shards.gguf_files.empty()) {
    fitParamsToFreeDeviceMemory(params, shards.gguf_files.front());
  }
  llama_model_params mparams = common_model_params_to_llama(params);
  auto pathsView =
      shards.gguf_files |
      std::views::transform([](const std::string& str) { return str.c_str(); });
  std::vector<const char*> pathsVec(pathsView.begin(), pathsView.end());
  llama_model* model =
      llama_model_load_from_splits(pathsVec.data(), pathsVec.size(), mparams);
  return common_init_from_model_and_params(model, params);
}

/// @brief Initializes a model from a single gguf stream stored in memory
/// @note For performance reasons `initFromShards` should be preferably used
/// with streams. However, this function is still offered to unify the Js
/// interface of the addon and separate concerns.
inline common_init_result_ptr initFromMemory(
    std::unique_ptr<std::basic_streambuf<char>>&& streambuf,
    common_params& params) {
  LOG_INF(
      "%s: load the model from single GGUF stream and apply lora adapter, if "
      "any.\n",
      __func__);
  llama_model_params mparams = common_model_params_to_llama(params);

  // Transfer the (Js) blobs to a contiguous memory block
  // Potential for optimization here. However for performance reasons,
  // sharded models should be used instead.
  std::vector<uint8_t> contiguousData;
  {
    // Scope streambuf so that it is destroyed after reading, and JS garbage
    // collection triggered.
    std::unique_ptr<std::basic_streambuf<char>> scopedStreambuf =
        std::move(streambuf);

    std::istream stream(scopedStreambuf.get());
    stream.seekg(0, std::ios::end);
    std::streampos size = stream.tellg();
    stream.seekg(0, std::ios::beg);
    contiguousData.resize(static_cast<size_t>(size));
    stream.read(reinterpret_cast<char*>(contiguousData.data()), size);
  }

  llama_model* model =
      llama_model_load_from_buffer(std::move(contiguousData), mparams);
  return common_init_from_model_and_params(model, params);
}

/// @brief Initialize a model handling streaming, not-streaming, sharded or
/// unsharded
/// @param modelPath Model to load (single .gguf)
/// @param singleGgufStreamedFiles Map containing .gguf files that finished
/// streaming
/// @param shards Containing sharded files, if any
/// @param loading_context What context to use when asynchronously loading
/// shards
/// @param isStreaming Should be set to true when `setWeightsForFile` is
/// being used to populate `singleGgufStreamedFiles` or call
/// `llama_model_load_fulfill_split_future`
inline common_init_result_ptr initFromConfig(
    common_params& params, const std::string& modelPath,
    std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>>&
        singleGgufStreamedFiles,
    const GGUFShards& shards, const std::string loading_context,
    const bool isStreaming, const char* AddonID, const std::string& error) {
  common_init_result_ptr llamaInit;
  // Stream should have been awaited by the time activate is called from JS
  // and init is triggered. isStreaming should be (thread) safe to use at this
  // point because `setWeightsForFile` has already finished.
  if (isStreaming) {
    if (shards.gguf_files.empty()) {
      // Not optimal. Shards preferred when streaming.
      LOG_INF(
          "%s: load the model gguf from stream and apply lora adapter, if "
          "any.\n",
          __func__);
      auto modelFilename = std::filesystem::path(modelPath).filename().string();
      auto itGgufModelPath = singleGgufStreamedFiles.find(modelFilename);
      if (itGgufModelPath == singleGgufStreamedFiles.end()) {
        // Build list of available files
        std::string availableFiles;
        if (!singleGgufStreamedFiles.empty()) {
          availableFiles = " Available files: ";
          bool first = true;
          for (const auto& [key, value] : singleGgufStreamedFiles) {
            if (!first)
              availableFiles += ", ";
            availableFiles += key;
            first = false;
          }
        } else {
          availableFiles = " No files available.";
        }

        std::string errorMsg = string_format(
            "%s: failed to load model from %s.%s\n",
            __func__,
            modelPath.c_str(),
            availableFiles.c_str());
        throw qvac_errors::StatusError(AddonID, error, errorMsg);
      }
      llamaInit =
          std::move(initFromMemory(std::move(itGgufModelPath->second), params));
      singleGgufStreamedFiles.erase(itGgufModelPath);
    } else {
      LOG_INF(
          "%s: load the sharded model and apply lora adapter, if any.\n",
          __func__);
      llamaInit = std::move(initFromShards(shards, params, loading_context));
    }
  } else {
    if (shards.gguf_files.empty()) {
      LOG_INF(
          "%s: load the model from disk file and apply lora adapter, if any.\n",
          __func__);
      // `error_code` overload, matching fitParamsToFreeDeviceMemory: the
      // throwing form turns an unreadable parent directory into a
      // `filesystem_error` that escapes unmapped, where the caller expects the
      // structured StatusError below.
      std::error_code modelExistsError;
      if (!std::filesystem::exists(modelPath, modelExistsError)) {
        throw qvac_errors::StatusError(
            AddonID,
            error,
            string_format(
                "%s: model file not found: %s\n", __func__, modelPath.c_str()));
      }
      // Fit here rather than leave it to `common_init_from_params`, which runs
      // the same fitter in place against `params`' own buffers and then
      // discards the status. Two things follow from that. It never noticed that
      // a caller who set no override of its own handed the fitter a null
      // `tensor_buft_overrides` — fabric pads that vector in
      // `common_params_parse_ex` (common/arg.cpp), so a consumer reaching
      // fabric through `common_params_parse` was covered, but one assembling
      // `common_params` by hand, as llm-llamacpp does via
      // `common_params_parser_init` plus its own handler dispatch, was not, and
      // its models loaded unfitted with nothing in the log to say so. And when
      // the fitter throws mid-descent it restores the two parameter structs but
      // not the buffers they point at, so the load inherited a placement the
      // fitter had just rejected. Routing through the helper puts this path on
      // the same scratch buffers, the same observed status and the same lock as
      // the sharded one.
      fitParamsToFreeDeviceMemory(params, modelPath);
      // The fit has run, under conditions where its result is checked; fabric
      // must not now repeat it in place. `common_init_from_params` gates its
      // own fit on this flag, so clear it across the call — and put it back
      // afterwards, because the flag records what the caller asked for rather
      // than what has already happened, and that is what a reload comparison
      // reads it for. Nothing reads it between the restore and the caller
      // regaining control.
      const bool fitRequested = std::exchange(params.fit_params, false);
      llamaInit = std::move(common_init_from_params(params));
      params.fit_params = fitRequested;
    } else {
      LOG_INF(
          "%s: load the model shards from disk file and apply lora adapter, if "
          "any.\n",
          __func__);
      llamaInit = std::move(initFromShards(shards, params));
    }
  }
  return llamaInit;
}
