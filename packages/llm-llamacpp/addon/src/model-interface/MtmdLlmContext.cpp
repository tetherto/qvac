#include "MtmdLlmContext.hpp"

#include <algorithm>
#include <cassert>
#include <string_view>

#include <common/log.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama/mtmd/mtmd-helper.h>
#include <llama/mtmd/mtmd.h>

#include "ContextSlider.hpp"
#include "GenerationParamsApply.hpp"
#include "addon/LlmErrors.hpp"
#include "inference-addon-cpp/Logger.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/VisionPrefixCache.hpp"

using namespace qvac_lib_inference_addon_llama;
using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::utils;

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
MtmdLlmContext::MtmdLlmContext(
    common_params& commonParams, common_init_result_ptr llamaInit,
    ToolsCompactController& tools, std::size_t visionCacheBudgetBytes)
    : tools_(tools), llamaInit_(std::move(llamaInit)), params_(commonParams),
      visionPrefixCache_(visionCacheBudgetBytes),
      visionCacheKeyPrefix_(makeVisionCacheKeyPrefix(
          commonParams.model.path, commonParams.mmproj.path)) {
  modelCtx_.model = llamaInit_->model();
  modelCtx_.lctx = llamaInit_->context();

  if (modelCtx_.model == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(UnableToLoadModel),
        "Failed to initialize model.");
  }

  if (modelCtx_.lctx == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(UnableToLoadModel),
        "Failed to initialize context");
  }

  modelCtx_.vocab = llama_model_get_vocab(modelCtx_.model);

  std::string chatTemplate =
      getChatTemplate(modelCtx_.model, params_, tools_.enabled());
  tmpls_ = common_chat_templates_init(modelCtx_.model, chatTemplate);

  smpl_.reset(common_sampler_init(modelCtx_.model, params_.sampling));
  if (!smpl_) {
    std::string errorMsg = string_format(
        "[MtmdLlm] %s: failed to initialize sampling subsystem\n", __func__);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToCreateSamplingSystem), errorMsg);
  }

  if ((llama_model_chat_template(modelCtx_.model, nullptr) == nullptr) &&
      params_.chat_template.empty()) {
    QLOG_IF(
        Priority::ERROR,
        string_format(
            "[MtmdLlm] %s: Model does not have chat template\n", __func__));
    QLOG_IF(
        Priority::ERROR,
        "[MtmdLlm]   For old llava models, you may need to use "
        "'--chat-template "
        "vicuna'\n");
    QLOG_IF(
        Priority::ERROR,
        "[MtmdLlm]   For MobileVLM models, use '--chat-template deepseek'\n");
    QLOG_IF(
        Priority::ERROR,
        "[MtmdLlm]   For Mistral Small 3.1, use '--chat-template "
        "mistral-v7'\n");
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "Model does not have chat template");
  }

  initVisionContext();

  // antiprompt init
  for (const std::string& antiprompt : params_.antiprompt) {
    auto ids = ::common_tokenize(modelCtx_.lctx, antiprompt, false, true);
    if (ids.size() == 1) {
      antipromptTokens_.push_back(ids[0]);
    }
  }

  // load antiprompt tokens for legacy templates
  if (params_.chat_template == "vicuna") {
    auto tempTokens =
        common_tokenize(modelCtx_.lctx, "ASSISTANT:", false, true);
    antipromptTokens_.insert(
        antipromptTokens_.end(), tempTokens.begin(), tempTokens.end());
  } else if (params_.chat_template == "deepseek") {
    auto tempTokens = common_tokenize(modelCtx_.lctx, "###", false, true);
    antipromptTokens_.insert(
        antipromptTokens_.end(), tempTokens.begin(), tempTokens.end());
  }

  isHarmonyModel_ =
      qvac_lib_inference_addon_llama::utils::isHarmonyModel(modelCtx_.model);
  if (isHarmonyModel_) {
    harmonyCallToken_ =
        qvac_lib_inference_addon_llama::utils::getHarmonyCallToken(
            modelCtx_.lctx);
    if (harmonyCallToken_ == LLAMA_TOKEN_NULL) {
      isHarmonyModel_ = false;
    }
  }
  QLOG_IF(
      Priority::DEBUG,
      string_format(
          "[MtmdLlm] Harmony detection: isHarmony=%d callToken=%d\n",
          isHarmonyModel_,
          harmonyCallToken_));
}

void MtmdLlmContext::initVisionContext() {
  const char* clipPath = params_.mmproj.path.c_str();
  mtmd_context_params mparams = mtmd_context_params_default();
  mparams.use_gpu = params_.mmproj_use_gpu;
  mparams.backend_device =
      params_.mmproj_backend.empty() ? nullptr : params_.mmproj_backend.c_str();
  mparams.print_timings = true;
  mparams.n_threads = params_.cpuparams.n_threads;
  ctxVision_.reset(mtmd_init_from_file(clipPath, modelCtx_.model, mparams));
  if (ctxVision_.get() == nullptr) {
    std::string errorMsg = string_format(
        "[MtmdLlm] Failed to load vision model from %s\n", clipPath);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadModel), errorMsg);
  }
}

bool MtmdLlmContext::checkAntiprompt() {
  if (!params_.antiprompt.empty()) {
    constexpr int kNPrev = 32;
    std::string lastOutput =
        common_sampler_prev_str(smpl_.get(), modelCtx_.lctx, kNPrev);

    // Check if each of the reverse prompts appears anywhere in the recent
    // output. We search the full kNPrev-token window because a single token
    // can decode to many characters, and a short antiprompt like "\n" may
    // appear at the start of such a token, far from the string's tail.
    // Matching is case-insensitive so callers don't have to list every
    // casing variant the model might emit.
    std::string lastOutputLower = lastOutput;
    std::transform(
        lastOutputLower.begin(),
        lastOutputLower.end(),
        lastOutputLower.begin(),
        [](unsigned char c) { return std::tolower(c); });
    for (const std::string& antiprompt : params_.antiprompt) {
      std::string antipromptLower = antiprompt;
      std::transform(
          antipromptLower.begin(),
          antipromptLower.end(),
          antipromptLower.begin(),
          [](unsigned char c) { return std::tolower(c); });
      if (lastOutputLower.find(antipromptLower) != std::string::npos) {
        return true;
      }
    }

    // check for reverse prompt using special tokens
    llama_token lastToken = common_sampler_last(smpl_.get());
    for (auto token : antipromptTokens_) {
      if (token == lastToken) {
        return true;
      }
    }
  }
  return false;
}

void MtmdLlmContext::tokenizeChat(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, mtmd::input_chunks& chunks,
    bool isCacheLoaded) {
  if (chatMsgs.empty()) {
    std::string errorMsg =
        string_format("[MtmdLlm] %s: no chat messages provided\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }

  common_chat_templates_inputs inputs;
  std::string formattedChat;

  bool isLastMessageFromUser = false;
  bool addSpecial = false;

  if (current_.pos == 0 && !isCacheLoaded) {
    tools_.reset();
    const auto& lastRole = chatMsgs.back().role;
    isLastMessageFromUser = lastRole == "user" || lastRole == "tool";
    addSpecial = true;
  } else if (current_.pos > 0) {
    isLastMessageFromUser =
        chatMsgs.back().role == "user" || chatMsgs.back().role == "tool";
    common_sampler_reset(smpl_.get());
    addSpecial = false;
  }

  inputs.use_jinja = params_.use_jinja;
  inputs.enable_thinking = params_.reasoning_budget != 0;
  inputs.messages = chatMsgs;
  inputs.add_generation_prompt = isLastMessageFromUser;

  if (!tools.empty()) {
    inputs.tools = tools;
  }
  formattedChat = getPrompt(tmpls_.get(), inputs, &thinkingForcedOpen_);

  if (formattedChat.empty()) {
    std::string errorMsg = string_format(
        "[MtmdLlm] %s: formatted chat prompt is empty\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }

  QLOG_IF(
      Priority::DEBUG,
      string_format("[MtmdLlm] formatted prompt: %s\n", formattedChat.c_str()));

  mtmd_input_text text;
  text.text = formattedChat.c_str();
  text.add_special = addSpecial;
  text.parse_special = true;

  auto bitmapsCPtr = bitmaps_.c_ptr();
  int32_t res = mtmd_tokenize(
      ctxVision_.get(),
      chunks.ptr.get(), // output
      &text,            // text
      bitmapsCPtr.data(),
      bitmapsCPtr.size());
  if (res != 0) {
    resetMedia();
    std::string errorMsg = string_format(
        "[MtmdLlm] %s: Unable to tokenize prompt, res = %d\n", __func__, res);
    throw qvac_errors::StatusError(ADDON_ID, toString(EncoderFailed), errorMsg);
  }

  if (tools_.enabled() && !tools.empty()) {
    inputs.tools = {};
    inputs.add_generation_prompt = false;
    inputs.use_jinja = params_.use_jinja;
    inputs.enable_thinking = params_.reasoning_budget != 0;
    auto promptNoTools = getPrompt(tmpls_.get(), inputs);

    if (!promptNoTools.empty()) {
      mtmd_input_text textNoTools;
      textNoTools.text = promptNoTools.c_str();
      textNoTools.add_special = addSpecial;
      textNoTools.parse_special = true;

      mtmd::input_chunks chunksNoTools(mtmd_input_chunks_init());
      int32_t resNoTools = mtmd_tokenize(
          ctxVision_.get(),
          chunksNoTools.ptr.get(),
          &textNoTools,
          bitmapsCPtr.data(),
          bitmapsCPtr.size());

      if (resNoTools == 0) {
        tools_.onTokenize(
            mtmd_helper_get_n_tokens(chunks.ptr.get()),
            mtmd_helper_get_n_tokens(chunksNoTools.ptr.get()));
      }
    }
  } else {
    tools_.onTokenize(mtmd_helper_get_n_tokens(chunks.ptr.get()), 0);
  }

  resetMedia();
}

bool MtmdLlmContext::evalMessage(
    const std::vector<common_chat_msg>& chatMsgs, bool isCacheLoaded,
    bool prefill) {
  return evalMessageWithTools(chatMsgs, {}, isCacheLoaded, prefill);
}

bool MtmdLlmContext::evalMessageWithTools(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, bool isCacheLoaded,
    bool prefill) {
  mtmd::input_chunks chunks(mtmd_input_chunks_init());

  tokenizeChat(chatMsgs, tools, chunks, isCacheLoaded);

  const bool isFirstMsg = (current_.pos == 0);

  const mtmd_input_chunks* chunksPtr = chunks.ptr.get();

  const llama_pos nTokens =
      static_cast<llama_pos>(mtmd_helper_get_n_tokens(chunksPtr));
  const llama_pos nPositions = mtmd_helper_get_n_pos(chunksPtr);
  const auto nCtx = static_cast<size_t>(llama_n_ctx(modelCtx_.lctx));
  const auto nCtxI32 = llama_n_ctx(modelCtx_.lctx);
  if (nTokens >= nCtxI32 || nPositions >= nCtxI32) {
    std::string errorMsg = string_format(
        "[MtmdLlm] context overflow at prefill step (%d tokens, %d positions, "
        "max %d)\n",
        nTokens,
        nPositions,
        nCtxI32);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextOverflow), errorMsg);
  }
  // Generation headroom: the prefill must leave room not just for the prompt
  // but for the tokens we are about to generate. n_predict > 0 reserves exactly
  // that many; n_predict < 0 (unlimited, the documented default) reserves a
  // minimum; n_predict == 0 is prefill-only. Shared with the A3 guard below so
  // the slide trigger and the guard use the same threshold — otherwise a prompt
  // that fits but leaves no room to generate falls into a "dead zone" where no
  // slide fires yet the guard throws, even though sliding (n_discarded > 0)
  // could have freed the room.
  constexpr size_t kMinGenerationHeadroom = 64;
  constexpr size_t kSafetyMargin = 16;
  size_t nPredict;
  if (params_.n_predict > 0) {
    nPredict = static_cast<size_t>(params_.n_predict);
  } else if (params_.n_predict == 0) {
    nPredict = 0;
  } else {
    nPredict = kMinGenerationHeadroom;
  }
  if (nPredict > nCtx) {
    nPredict = nCtx;
  }
  const auto genHeadroom = static_cast<llama_pos>(nPredict + kSafetyMargin);

  if (current_.pos + nPositions + genHeadroom > nCtxI32 ||
      current_.cacheTokens + nTokens + genHeadroom > nCtxI32) {
    auto outcome = trySlidePrefill(
        modelCtx_.lctx,
        seqId_,
        current_,
        protectedPrefix_,
        ContextUsage{nPositions + genHeadroom, nTokens + genHeadroom},
        nDiscarded_,
        tools_,
        defaultContextSliderOps());
    switch (outcome.kind) {
    case ContextSlideOutcome::Kind::Slid:
      current_.pos = outcome.newNPast;
      current_.cacheTokens -= outcome.discarded;
      ++nSlides_;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[MtmdLlm] Prefill step: discarded %d tokens after the first "
              "message\n",
              outcome.discarded));
      break;
    case ContextSlideOutcome::Kind::FullWipe:
      current_.pos = outcome.newNPast;
      current_.cacheTokens = current_.pos == protectedPrefix_.pos
                                 ? protectedPrefix_.cacheTokens
                                 : protectedPrefix_.cacheTokens + 1;
      ++nSlides_;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[MtmdLlm] Prefill step: wiped %d tokens after the first "
              "message\n",
              outcome.discarded));
      break;
    case ContextSlideOutcome::Kind::Overflow: {
      resetMedia();
      std::string errorMsg = string_format(
          "[MtmdLlm] context overflow at prefill step: nPast=%d + prompt=%d "
          "positions + generation headroom=%d would exceed n_ctx=%d, and "
          "sliding could not free enough room (n_discarded=%d). Increase "
          "ctx_size, raise n_discarded (sliding window), reduce image "
          "resolution, or shorten the conversation.\n",
          current_.pos,
          nPositions,
          genHeadroom,
          nCtxI32,
          nDiscarded_);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextOverflow), errorMsg);
    }
    case ContextSlideOutcome::Kind::MemoryOperationFailed: {
      std::string errorMsg = string_format(
          "[MtmdLlm] failed to slide context memory at prefill step "
          "(nPast=%d, cacheTokens=%d, append=%d, max=%d)\n",
          current_.pos,
          current_.cacheTokens,
          nTokens,
          nCtxI32);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextSlideFailed), errorMsg);
    }
    case ContextSlideOutcome::Kind::NotNeeded:
      break;
    }
  }

  // QVAC-19118 A3: final safety net. The headroom-aware slide above normally
  // frees room for generation (or throws Overflow if it cannot), so on a
  // recoverable conversation this does not fire. It still guards the cases the
  // slide cannot help with — n_discarded == 0 (sliding disabled) or a single
  // image larger than the window — which leave no room to generate even after a
  // full wipe. Fail here with an actionable error instead of after the
  // expensive encode + decode or a mid-generation overflow.
  {
    const size_t nPastPostSlide = static_cast<size_t>(current_.pos);
    const size_t nPromptPositions = static_cast<size_t>(nPositions);
    if (nPastPostSlide + nPromptPositions + nPredict + kSafetyMargin > nCtx) {
      resetMedia();
      std::string errorMsg = string_format(
          "[MtmdLlm] context overflow at prefill step: nPast=%zu + "
          "prompt=%zu positions + n_predict=%zu + safety=%zu would exceed "
          "n_ctx=%zu. Increase ctx_size, enable/raise n_discarded (sliding "
          "window), or reduce image resolution.\n",
          nPastPostSlide,
          nPromptPositions,
          nPredict,
          kSafetyMargin,
          nCtx);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextOverflow), errorMsg);
    }
  }

  size_t nChunks = mtmd_input_chunks_size(chunksPtr);
  if (nChunks == 0) {
    const char* errorMsg = "[MtmdLlm] Unable to eval prompt\n";
    throw qvac_errors::StatusError(ADDON_ID, toString(EncoderFailed), errorMsg);
  }

  llama_pos nPastLocal = current_.pos;

  for (size_t i = 0; i < nChunks; i++) {
    bool chunkLogitsLast = (i == nChunks - 1 && !prefill);
    const auto* chunk = mtmd_input_chunks_get(chunksPtr, i);

    if (stopGeneration_.load()) {
      llama_pos totalDelta = nPastLocal - current_.pos;
      current_.pos = nPastLocal;
      removeLastNTokens(totalDelta);
      stopGeneration_.store(false);
      return false;
    }

    // QVAC-19118 A2: image chunks bypass mtmd_helper_eval_chunk_single
    // (which always re-runs CLIP encode + projection) when their bytes hash
    // is in our cache. Cache stores post-projection embeddings; on hit we
    // hand them directly to mtmd_helper_decode_image_chunk, which only
    // sets up KV positions / non-causal attention and runs llama_decode.
    // Text and audio chunks fall through to the existing helper unchanged.
    if (mtmd_input_chunk_get_type(chunk) == MTMD_INPUT_CHUNK_TYPE_IMAGE) {
      const char* idC = mtmd_input_chunk_get_id(chunk);
      const std::string_view imageHashView =
          (idC != nullptr) ? std::string_view(idC) : std::string_view{};
      std::string cacheKey;
      if (!imageHashView.empty() && visionPrefixCache_.budgetBytes() > 0) {
        cacheKey.reserve(visionCacheKeyPrefix_.size() + imageHashView.size());
        cacheKey.append(visionCacheKeyPrefix_);
        cacheKey.append(imageHashView);
      }

      const std::size_t nTokensChunk = mtmd_input_chunk_get_n_tokens(chunk);
      const std::size_t nEmbd =
          static_cast<std::size_t>(llama_model_n_embd(modelCtx_.model));

      auto cached =
          cacheKey.empty() ? nullptr : visionPrefixCache_.get(cacheKey);
      // Decode from cache ONLY when the cached buffer exactly matches the
      // shape mtmd_helper_decode_image_chunk will read for THIS chunk: it
      // consumes mtmd_input_chunk_get_n_tokens(chunk) * n_embd floats from
      // the buffer, and nPos must agree (M-RoPE models can differ from
      // nTokens). A mismatch (hash collision, or a change in image
      // preprocessing for the same bytes) would otherwise read out of
      // bounds or advance positions incorrectly. On mismatch we fall
      // through and re-encode from scratch.
      if (cached && nEmbd != 0 && cached->nTokens == nTokensChunk &&
          cached->embeddings.size() == nTokensChunk * nEmbd &&
          cached->nPos == mtmd_input_chunk_get_n_pos(chunk)) {
        // Cache hit: get() returns a shared_ptr (zero-copy, thread-safe).
        // The API takes non-const float* but only reads from the buffer.
        int32_t res = mtmd_helper_decode_image_chunk(
            ctxVision_.get(),
            modelCtx_.lctx,
            chunk,
            const_cast<float*>(cached->embeddings.data()),
            nPastLocal,
            0,
            params_.n_batch,
            &nPastLocal);
        if (res != 0) {
          std::string errorMsg = "[MtmdLlm] failed to decode cached image "
                                 "chunk " +
                                 std::to_string(i);
          throw qvac_errors::StatusError(
              ADDON_ID, toString(EncoderFailed), errorMsg);
        }
        continue;
      }

      // Cache miss: run CLIP + projection ourselves so we can capture and
      // copy the post-projection embeddings before they're overwritten by
      // a subsequent encode call (the libmtmd output buffer is reused).
      if (mtmd_encode_chunk(ctxVision_.get(), chunk) != 0) {
        std::string errorMsg =
            "[MtmdLlm] failed to encode image chunk " + std::to_string(i);
        throw qvac_errors::StatusError(
            ADDON_ID, toString(EncoderFailed), errorMsg);
      }

      // CRITICAL invariant: mtmd_get_output_embd() returns a pointer into
      // libmtmd's internal scratch buffer that is OVERWRITTEN on the next
      // mtmd_encode_chunk() call. Deep-copy NOW, before any further
      // encode runs (e.g. a second image chunk in this same loop).
      const float* embd = mtmd_get_output_embd(ctxVision_.get());

      if (embd == nullptr || nTokensChunk == 0 || nEmbd == 0) {
        std::string errorMsg = string_format(
            "[MtmdLlm] encoder returned no output for image chunk %zu "
            "(embd=%p, nTokens=%zu, nEmbd=%zu)\n",
            i,
            static_cast<const void*>(embd),
            nTokensChunk,
            nEmbd);
        throw qvac_errors::StatusError(
            ADDON_ID, toString(EncoderFailed), errorMsg);
      }
      // Guard both the element count (nTokensChunk * nEmbd) and the byte
      // product (* sizeof(float)) that VisionCacheEntry::sizeBytes() later
      // computes. The || short-circuits, so the second multiply is only
      // evaluated once the first check proves nTokensChunk * nEmbd is safe.
      if (nTokensChunk > SIZE_MAX / nEmbd ||
          nTokensChunk * nEmbd > SIZE_MAX / sizeof(float)) {
        std::string errorMsg = string_format(
            "[MtmdLlm] embedding size overflow: nTokens=%zu * nEmbd=%zu "
            "(* sizeof(float)) exceeds SIZE_MAX\n",
            nTokensChunk,
            nEmbd);
        throw qvac_errors::StatusError(
            ADDON_ID, toString(EncoderFailed), errorMsg);
      }

      VisionCacheEntry entry;
      entry.embeddings.assign(embd, embd + nTokensChunk * nEmbd);
      entry.nTokens = nTokensChunk;
      entry.nPos = mtmd_input_chunk_get_n_pos(chunk);
      if (const auto* imgTokens = mtmd_input_chunk_get_tokens_image(chunk)) {
        entry.nx = mtmd_image_tokens_get_nx(imgTokens);
        entry.ny = mtmd_image_tokens_get_ny(imgTokens);
      }

      int32_t res = mtmd_helper_decode_image_chunk(
          ctxVision_.get(),
          modelCtx_.lctx,
          chunk,
          entry.embeddings.data(),
          nPastLocal,
          0,
          params_.n_batch,
          &nPastLocal);
      if (res != 0) {
        std::string errorMsg =
            "[MtmdLlm] failed to decode image chunk " + std::to_string(i);
        throw qvac_errors::StatusError(
            ADDON_ID, toString(EncoderFailed), errorMsg);
      }

      // Only insert if the bitmap had an ID we could hash and we actually
      // captured embeddings. An empty key would short-circuit lookup
      // anyway, but the explicit check keeps stats honest.
      if (!cacheKey.empty() && !entry.embeddings.empty()) {
        visionPrefixCache_.put(std::move(cacheKey), std::move(entry));
      }
      continue;
    }

    int32_t res = mtmd_helper_eval_chunk_single(
        ctxVision_.get(),
        modelCtx_.lctx,
        chunk,
        nPastLocal,
        0,
        params_.n_batch,
        chunkLogitsLast,
        &nPastLocal);
    if (res != 0) {
      std::string errorMsg =
          "[MtmdLlm] failed to eval chunk " + std::to_string(i);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(EncoderFailed), errorMsg);
    }
  }
  current_.pos = nPastLocal;
  current_.cacheTokens += nTokens;

  if (isFirstMsg) {
    protectedPrefix_ = current_;
    const auto ctxSize = static_cast<llama_pos>(llama_n_ctx(modelCtx_.lctx));
    if (nDiscarded_ >= ctxSize - protectedPrefix_.pos) {
      nDiscarded_ = ctxSize - protectedPrefix_.pos - 1;
    }
  }
  tools_.onEvalComplete(current_.pos, nPositions);
  return true;
}

void MtmdLlmContext::flushPendingUtf8ToCallback(
    const std::function<void(const std::string&)>& outputCallback) {
  if (!outputCallback || !utf8Buffer_.hasPendingBytes()) {
    return;
  }
  std::string remaining = utf8Buffer_.flush();
  if (!remaining.empty()) {
    outputCallback(remaining);
  }
}

void MtmdLlmContext::applyContextDiscard() {
  constexpr llama_pos effectiveCtx = -1;
  auto outcome = trySlideGeneration(
      modelCtx_.lctx,
      seqId_,
      current_.pos,
      protectedPrefix_.pos,
      nDiscarded_,
      tools_,
      defaultContextSliderOps(),
      effectiveCtx,
      current_.cacheTokens);
  if (outcome.kind == ContextSlideOutcome::Kind::Slid) {
    current_.pos = outcome.newNPast;
    current_.cacheTokens -= outcome.discarded;
    ++nSlides_;
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[MtmdLlm] discarded %d tokens after the first message\n",
            outcome.discarded));
  } else if (outcome.kind == ContextSlideOutcome::Kind::MemoryOperationFailed) {
    std::string errorMsg = string_format(
        "[MtmdLlm] failed to slide context memory during generation "
        "(nPast=%d, nDiscarded=%d)\n",
        current_.pos,
        nDiscarded_);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextSlideFailed), errorMsg);
  }
}

void MtmdLlmContext::handleStopRequestAndAddEot(LlamaBatch& batch) {
  stopGeneration_.store(false);
  llama_token eot = llama_vocab_eot(modelCtx_.vocab);
  common_batch_add(
      *batch,
      eot == LLAMA_TOKEN_NULL ? llama_vocab_eos(modelCtx_.vocab) : eot,
      current_.pos++,
      {seqId_},
      true);
  if (llama_decode(modelCtx_.lctx, *batch) != 0) {
    const char* errorMsg = "[MtmdLlm] failed to decode EOT token\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(FailedToDecode), errorMsg);
  }
  ++current_.cacheTokens;
}

bool MtmdLlmContext::generateResponse(
    const std::function<void(const std::string&)>& outputCallback) {

  int nRemain = params_.n_predict;
  LlamaBatch batch(1, 0, 1); // batch for next token generation

  if (thinkingForcedOpen_ && outputCallback) {
    // MtmdLlmContext doesn't carry a reasoningState_ (no reasoning-aware EOS
    // replacement on the multimodal path today), so unlike TextLlmContext we
    // only prepend the visible "<think>\n" opener and don't flip an
    // inside_reasoning flag. If reasoning state is added here later, mirror
    // TextLlmContext::generateResponse and set it true alongside this emit.
    outputCallback("<think>\n");
  }

  if (stopGeneration_.load()) {
    stopGeneration_.store(false);
    flushPendingUtf8ToCallback(outputCallback);
    return true;
  }

  while (nRemain != 0) {
    if (stopGeneration_.load()) {
      stopGeneration_.store(false);
      flushPendingUtf8ToCallback(outputCallback);
      return true;
    }
    if ((current_.pos + 1 >
             static_cast<llama_pos>(llama_n_ctx(modelCtx_.lctx)) ||
         current_.cacheTokens + 1 >
             static_cast<llama_pos>(llama_n_ctx(modelCtx_.lctx))) &&
        nDiscarded_ == 0) {
      QLOG_IF(
          Priority::WARNING,
          string_format(
              "[MtmdLlm] generation overflow: context is full and nDiscarded "
              "is "
              "0 (nPast=%d, nCtx=%d, firstMsgTokens=%d, nPastBeforeTools=%d, "
              "toolsCompact=%s)\n",
              current_.pos,
              llama_n_ctx(modelCtx_.lctx),
              protectedPrefix_.pos,
              tools_.anchor(),
              tools_.enabled() ? "true" : "false"));
      return false;
    }
    applyContextDiscard();

    llama_token tokenId =
        common_sampler_sample(smpl_.get(), modelCtx_.lctx, -1);
    common_sampler_accept(smpl_.get(), tokenId, true);
    --nRemain;

    std::string tokenStr =
        common_token_to_piece(modelCtx_.lctx, tokenId, params_.special);
    if (outputCallback) {
      std::string completeChars = utf8Buffer_.addToken(tokenStr);
      if (!completeChars.empty()) {
        outputCallback(completeChars);
      }
    }

    bool isEos = llama_vocab_is_eog(modelCtx_.vocab, tokenId);

    if (isEos && isHarmonyModel_ && params_.use_jinja &&
        tokenId == harmonyCallToken_) {
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[MtmdLlm] Harmony <|call|> stop: tokenId=%d\n", tokenId));
      if (outputCallback) {
        std::string callMarker =
            common_token_to_piece(modelCtx_.lctx, tokenId, true);
        if (!callMarker.empty()) {
          outputCallback(callMarker);
        }
      }
      flushPendingUtf8ToCallback(outputCallback);
      break;
    }

    if (isEos || checkAntiprompt()) {
      flushPendingUtf8ToCallback(outputCallback);
      break;
    }

    common_batch_clear(*batch);
    if (stopGeneration_.load()) {
      handleStopRequestAndAddEot(batch);
      break;
    }
    common_batch_add(*batch, tokenId, current_.pos++, {seqId_}, true);

    // eval the token
    if (llama_decode(modelCtx_.lctx, *batch) != 0) {
      const char* errorMsg = "[MtmdLlm] failed to decode next token\n";
      throw qvac_errors::StatusError(
          ADDON_ID, toString(FailedToDecode), errorMsg);
    }
    ++current_.cacheTokens;
  }

  if (nRemain == 0) {
    flushPendingUtf8ToCallback(outputCallback);
  }
  return true;
}

std::function<void()>
MtmdLlmContext::applyGenerationParams(const GenerationParams& overrides) {
  return applyGenerationParamsToContext(
      params_, smpl_, modelCtx_.model, overrides);
}

void MtmdLlmContext::stop() { stopGeneration_.store(true); }

llama_context* MtmdLlmContext::getCtx() { return modelCtx_.lctx; }

llama_pos MtmdLlmContext::getNPast() const { return current_.pos; }

void MtmdLlmContext::setNPast(llama_pos nPast) { current_.pos = nPast; }

llama_pos MtmdLlmContext::getCacheTokens() const {
  return current_.cacheTokens;
}

void MtmdLlmContext::setCacheTokens(llama_pos cacheTokens) {
  current_.cacheTokens = cacheTokens;
}

llama_pos MtmdLlmContext::getFirstMsgTokens() const {
  return protectedPrefix_.pos;
}

void MtmdLlmContext::setFirstMsgTokens(llama_pos firstMsgTokens) {
  protectedPrefix_.pos = firstMsgTokens;
}

llama_pos MtmdLlmContext::getFirstMsgCacheTokens() const {
  return protectedPrefix_.cacheTokens;
}

void MtmdLlmContext::setFirstMsgCacheTokens(llama_pos firstMsgCacheTokens) {
  protectedPrefix_.cacheTokens = firstMsgCacheTokens;
}

void MtmdLlmContext::setNDiscarded(llama_pos nDiscarded) {
  this->nDiscarded_ = nDiscarded;
}

int32_t MtmdLlmContext::getNSlides() const { return nSlides_; }
void MtmdLlmContext::resetNSlides() { nSlides_ = 0; }

void MtmdLlmContext::loadMedia(const std::vector<uint8_t>& media) {
  if (media.empty()) {
    resetMedia();
    const char* errorMsg = "[MtmdLlm] Media buffer is empty\n";
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  if (ctxVision_.get() == nullptr) {
    resetMedia();
    const char* errorMsg = "[MtmdLlm] Vision context is not initialized\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadModel), errorMsg);
  }

  mtmd::bitmap bmp(mtmd_helper_bitmap_init_from_buf(
      ctxVision_.get(), media.data(), media.size()));
  if (!bmp.ptr) {
    resetMedia();
    const char* errorMsg =
        "[MtmdLlm] Failed to load media from memory buffer\n";
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }
  if (visionPrefixCache_.budgetBytes() > 0) {
    const std::string hash = sha256OfBytes(media);
    if (!hash.empty()) {
      bmp.set_id(hash.c_str());
    }
  }
  bitmaps_.entries.push_back(std::move(bmp));
}

void MtmdLlmContext::loadMedia(const std::string& fname) {
  if (fname.empty()) {
    resetMedia();
    const char* errorMsg = "[MtmdLlm] Filename is empty\n";
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  if (ctxVision_.get() == nullptr) {
    resetMedia();
    const char* errorMsg = "[MtmdLlm] Vision context is not initialized\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadModel), errorMsg);
  }

  mtmd::bitmap bmp(
      mtmd_helper_bitmap_init_from_file(ctxVision_.get(), fname.c_str()));
  if (!bmp.ptr) {
    resetMedia();
    std::string errorMsg = string_format(
        "[MtmdLlm] Failed to load media from file: %s\n", fname.c_str());
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }
  if (visionPrefixCache_.budgetBytes() > 0) {
    const std::string hash = sha256OfFile(fname);
    if (!hash.empty()) {
      bmp.set_id(hash.c_str());
    }
  }
  bitmaps_.entries.push_back(std::move(bmp));
}

void MtmdLlmContext::resetState(bool resetStats) {

  tools_.reset();
  current_ = {};
  protectedPrefix_ = {};

  // On partial reset (resetStats=false), preserve nSlides_ so
  // runtimeStats() can read the per-inference value.
  // On full reset (resetStats=true), clear it along with perf stats.
  if (resetStats) {
    nSlides_ = 0;
  }

  // Clear UTF-8 buffer when resetting state
  utf8Buffer_.clear();

  // Vision prefix cache stores raw post-projection embeddings keyed by image
  // SHA-256. Entries are context-independent and re-injected into fresh KV
  // contexts via mtmd_helper_decode_image_chunk, so they remain valid across
  // KV resets and cacheKey changes. Data persists for the model lifetime;
  // cleared only on destroy or onMemoryWarning().
  if (resetStats) {
    visionPrefixCache_.clearStats();
  }

  clearSequenceMemory(modelCtx_.lctx);

  // Reset the performance metrics
  if (resetStats) {
    llama_perf_context_reset(modelCtx_.lctx);
  }

  // Reset sampler if available
  common_sampler_reset(smpl_.get());

  // Synchronize to ensure all operations are complete
  llama_synchronize(modelCtx_.lctx);
}

void MtmdLlmContext::resetMedia() { bitmaps_.entries.clear(); }

llama_pos MtmdLlmContext::removeLastNTokens(llama_pos count) {
  // Validate input
  if (count <= 0) {
    return 0;
  }

  // Calculate how many tokens we can actually remove
  llama_pos tokensToRemove = std::min(count, current_.pos);

  if (tokensToRemove == 0) {
    return 0;
  }

  clearSequenceMemory(modelCtx_.lctx, current_.pos - tokensToRemove, -1);

  // Decrement the token count by the number of tokens removed
  current_.pos -= tokensToRemove;
  current_.cacheTokens -= std::min(tokensToRemove, current_.cacheTokens);

  // Note: The sampler doesn't have an "undo" function, so we leave it as is.
  // The sampler maintains its own history, but the removed tokens won't affect
  // future sampling since they're no longer in the KV cache.

  return tokensToRemove;
}
