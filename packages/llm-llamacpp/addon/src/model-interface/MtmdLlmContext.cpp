#include "MtmdLlmContext.hpp"

#include <algorithm>
#include <cassert>
#include <filesystem>
#include <system_error>

#include <common/log.h>
#include <gguf.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama/mtmd/mtmd-helper.h>
#include <llama/mtmd/mtmd.h>

#include "ContextSlider.hpp"
#include "GenerationParamsApply.hpp"
#include "MediaLoadOrder.hpp"
#include "addon/LlmErrors.hpp"
#include "inference-addon-cpp/Logger.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ScopeGuard.hpp"
// NOLINTNEXTLINE(readability-function-cognitive-complexity)
// NOLINTNEXTLINE(readability-function-cognitive-complexity)

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::utils;

namespace {
bool isFileInitialized(const std::filesystem::path& path) {
  std::error_code errorCode;
  const auto size = std::filesystem::file_size(path, errorCode);
  return !errorCode && size != 0;
}
} // namespace

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
MtmdLlmContext::MtmdLlmContext(
    common_params& commonParams, common_init_result_ptr llamaInit,
    ToolsCompactController& tools)
    : tools_(tools), llamaInit_(std::move(llamaInit)), params_(commonParams) {
  modelCtx_.model = llamaInit_->model();
  modelCtx_.lctx = llamaInit_->context();
  initializeCommonState();
}

MtmdLlmContext::MtmdLlmContext(
    const common_params& commonParams, const LlmModelContext& shared,
    ToolsCompactController& tools, mtmd_context* sharedVision,
    llama_seq_id seqId, llama_pos perSeqCtxCeiling)
    : tools_(tools), sharedVision_(sharedVision), modelCtx_(shared),
      params_(commonParams), perSeqCtxCeiling_(perSeqCtxCeiling) {
  seqId_ = seqId;
  if (sharedVision_ == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadModel),
        "MtmdLlmContext: per-slot driver requires a shared vision context");
  }
  initializeCommonState();
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
void MtmdLlmContext::initializeCommonState() {
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

  if (modelCtx_.vocab == nullptr) {
    modelCtx_.vocab = llama_model_get_vocab(modelCtx_.model);
  }

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

  if (sharedVision_ == nullptr) {
    initVisionContext();
  }

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

  // Recurrent-memory detection: mirrors TextLlmContext so that opting
  // into `remove_thinking_from_context` on a hybrid SSM (Qwen3.5/3.6)
  // is rejected with a clear error rather than silently producing
  // contaminated post-shift state.
  hasRecurrentMemory_ = llama_model_is_recurrent(modelCtx_.model);
  if (!hasRecurrentMemory_) {
    const std::optional<std::string> arch =
        qvac_lib_inference_addon_llama::utils::getModelArchitecture(
            modelCtx_.model);
    if (arch.has_value()) {
      const std::string ssmKey = arch.value() + ".ssm.state_size";
      char buffer[32] = {0};
      if (llama_model_meta_val_str(
              modelCtx_.model, ssmKey.c_str(), buffer, sizeof(buffer)) > 0) {
        hasRecurrentMemory_ = true;
      }
    }
  }

  // EOS-inside-reasoning recovery is a Qwen3-specific workaround;
  // gate it on the explicit Qwen3-family predicate so non-Qwen
  // reasoning families (e.g. Gemma 4) don't inherit it. See
  // TextLlmContext for the same gate.
  {
    const std::optional<std::string> arch =
        qvac_lib_inference_addon_llama::utils::getModelArchitecture(
            modelCtx_.model);
    isQwen3ReasoningFamily_ =
        arch.has_value() &&
        qvac_lib_inference_addon_llama::utils::
            isQwen3ReasoningFamilyArchitecture(arch.value());
  }
}

void MtmdLlmContext::initVisionContext() {
  const char* clipPath = params_.mmproj.path.c_str();
  mtmd_context_params mparams = mtmd_context_params_default();
  mparams.use_gpu = params_.mmproj_use_gpu;
  mparams.backend_device =
      params_.mmproj_backend.empty() ? nullptr : params_.mmproj_backend.c_str();
  mparams.print_timings = true;
  mparams.n_threads = params_.cpuparams.n_threads;
  mparams.image_tile_mode = params_.image_tile_mode;
  // Forward the per-image token budget to the vision encoder. These were
  // previously dropped: the addon parsed image_min/max_tokens into
  // common_params but never copied them into mtmd_context_params, so a
  // caller-set cap had no effect and the encoder always used the model-metadata
  // default (up to ~4M pixels -> thousands of patches). For dynamic-resolution
  // encoders (Qwen-VL, Pixtral, LFM2, ...) this lets callers bound the
  // O(n_patches^2) encode cost; for fixed-grid encoders it is a no-op.
  mparams.image_min_tokens = params_.image_min_tokens;
  mparams.image_max_tokens = params_.image_max_tokens;

  // When the caller has not set an explicit cap, apply a sensible default for
  // Qwen-VL encoders only. Qwen-VL allows up to 4096 image tokens, far more
  // than the ~1024 it needs for grounding, so an uncapped high-resolution
  // image pays O(n_patches^2) attention for tokens the model cannot use (and
  // can even destabilize generation). 2048 stays well above the documented
  // grounding floor while roughly halving the worst-case encode + image
  // prefill. We gate on the mmproj projector type rather than applying a
  // blanket value so that smaller-budget dynamic encoders (e.g. LightOnOCR /
  // Pixtral at 1024, LFM2 at 256) are never *raised* above their native limit;
  // fixed-grid encoders (SigLIP/SmolVLM) are unaffected regardless. Fully
  // overridable via image_max_tokens config.
  if (mparams.image_max_tokens <= 0) {
    static constexpr int kQwenVlDefaultImageMaxTokens = 2048;
    // Respect an explicit image_min_tokens floor. mtmd converts both knobs into
    // min/max pixel budgets and throws when max_pixels < min_pixels, so if the
    // caller asked for at least as many tokens as our default cap, injecting
    // the default max would make a min-only config fail to load. Leave the
    // budget to the caller / model default in that case.
    if (mparams.image_min_tokens < kQwenVlDefaultImageMaxTokens) {
      gguf_init_params gp = {};
      gp.no_alloc = true;
      if (gguf_context* gc = gguf_init_from_file(clipPath, gp)) {
        // Mirror mtmd's projector-type resolution: it reads clip.projector_type
        // first and, for mixed vision+audio mmprojs, falls back to
        // clip.vision.projector_type. Reading only the generic key would miss
        // Qwen Omni vision encoders (e.g. Qwen3-Omni stores its vision merger
        // under the vision key), silently leaving them on the uncapped path.
        auto readProjType = [&](const char* key) -> std::string {
          const int64_t id = gguf_find_key(gc, key);
          if (id >= 0 && gguf_get_kv_type(gc, id) == GGUF_TYPE_STRING) {
            return gguf_get_val_str(gc, id);
          }
          return {};
        };
        std::string projType = readProjType("clip.projector_type");
        if (projType.empty()) {
          projType = readProjType("clip.vision.projector_type");
        }
        // Qwen vision mergers: qwen2vl_merger / qwen2.5vl_merger /
        // qwen3vl_merger. Plus qwen2.5o, the Qwen2.5-Omni combined projector,
        // which mtmd resolves to the Qwen2.5-VL vision merger for the vision
        // modality.
        const bool isQwenVlMerger = projType.rfind("qwen", 0) == 0 &&
                                    projType.find("vl") != std::string::npos;
        const bool isQwenOmni = projType == "qwen2.5o";
        if (isQwenVlMerger || isQwenOmni) {
          mparams.image_max_tokens = kQwenVlDefaultImageMaxTokens;
        }
        gguf_free(gc);
      }
    }
  }
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
  std::string thinkingStartTag;
  std::string thinkingEndTag;
  std::string generationPrompt;
  formattedChat = getPrompt(
      tmpls_.get(),
      inputs,
      &thinkingForcedOpen_,
      &thinkingStartTag,
      &thinkingEndTag,
      &generationPrompt);
  thinkingForcedOpenText_ =
      thinkingForcedOpen_
          ? getThinkingForcedOpenText(generationPrompt, thinkingStartTag)
          : std::string{};
  configureReasoningTags(
      thinkingStartTag, thinkingEndTag, thinkingForcedOpenText_);

  if (formattedChat.empty()) {
    std::string errorMsg = string_format(
        "[MtmdLlm] %s: formatted chat prompt is empty\n", __func__);
    throw qvac_errors::StatusError(ADDON_ID, toString(EmptyPrompt), errorMsg);
  }

  if (configureReasoningBudgetSampling(
          params_,
          modelCtx_.lctx,
          thinkingStartTag,
          thinkingEndTag,
          generationPrompt)) {
    smpl_.reset(common_sampler_init(modelCtx_.model, params_.sampling));
    if (!smpl_) {
      std::string errorMsg = string_format(
          "[MtmdLlm] %s: failed to initialize sampling subsystem\n", __func__);
      throw qvac_errors::StatusError(
          ADDON_ID, toString(UnableToCreateSamplingSystem), errorMsg);
    }
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
      visionContext(),
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
          visionContext(),
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
  if (nTokens >= llama_n_ctx(modelCtx_.lctx) ||
      nPositions >= llama_n_ctx(modelCtx_.lctx)) {
    std::string errorMsg = string_format(
        "[MtmdLlm] context overflow at prefill step (%d tokens, %d positions, "
        "max %d)\n",
        nTokens,
        nPositions,
        llama_n_ctx(modelCtx_.lctx));
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextOverflow), errorMsg);
  }
  if (current_.pos + nPositions >= llama_n_ctx(modelCtx_.lctx) ||
      current_.cacheTokens + nTokens >= llama_n_ctx(modelCtx_.lctx)) {
    auto outcome = trySlidePrefill(
        modelCtx_.lctx,
        seqId_,
        current_,
        protectedPrefix_,
        ContextUsage{nPositions, nTokens},
        nDiscarded_,
        tools_,
        defaultContextSliderOps());
    switch (outcome.kind) {
    case ContextSlideOutcome::Kind::Slid:
      current_.pos = outcome.newNPast;
      refreshCurrentCacheTokensFromMemory();
      ++nSlides_;
      QLOG_IF(
          Priority::DEBUG,
          string_format(
              "[MtmdLlm] Prefill step: discarded %d tokens after the first "
              "message\n",
              outcome.discarded));
      break;
    case ContextSlideOutcome::Kind::Overflow: {
      std::string errorMsg = string_format(
          "[MtmdLlm] context overflow at prefill step (%d tokens, max "
          "%d)\n",
          current_.cacheTokens + nTokens,
          llama_n_ctx(modelCtx_.lctx));
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
          llama_n_ctx(modelCtx_.lctx));
      throw qvac_errors::StatusError(
          ADDON_ID, toString(ContextSlideFailed), errorMsg);
    }
    case ContextSlideOutcome::Kind::NotNeeded:
      break;
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
      // [TODO] Temporary recurrent-memory fix: removeLastNTokens() may no-op for
      // hybrid/SSM models. A proper cancellation rollback needs llama.cpp
      // sequence checkpoint save + restore so partially evaluated tokens can
      // be restored without corrupting recurrent state.
      const llama_pos removedTokens = removeLastNTokens(totalDelta);
      if (removedTokens == 0 && totalDelta > 0) {
        // [TODO] Replace this metadata resync in the next PR with real
        // checkpoint save/restore rollback. This branch means rollback did not
        // remove the partially evaluated prompt, which is expected for
        // Qwen3VL hybrid/recurrent memory until checkpoint restore exists.
        //
        // The subtle case is cancellation between mtmd chunks: the image chunk
        // has already returned from mtmd_helper_eval_chunk_single(), so
        // nPastLocal has been advanced to the next chunk's cursor by the
        // Qwen3VL M-RoPE span (max(nx, ny)). But the following text chunk has
        // not run yet. llama memory currently contains only the committed image
        // KV cells, whose normal sequence position is the image chunk's pos.t;
        // the image x/y coordinates are stored as extended metadata and are not
        // reported by llama_memory_seq_pos_max().
        //
        // If we save nPastLocal as cache metadata here, disk reload can fail
        // because the saved nPast is ahead of the positions actually restored
        // from llama memory. Persist the memory-derived position until proper
        // rollback can restore the exact pre-cancel state.
        auto* mem = llama_get_memory(modelCtx_.lctx);
        if (mem == nullptr) {
          throw qvac_errors::StatusError(
              ADDON_ID,
              qvac_errors::general_error::toString(
                  qvac_errors::general_error::InternalError),
              "[MtmdLlm] llama memory is null while syncing canceled prefill "
              "position");
        }
        const llama_pos posMax = llama_memory_seq_pos_max(mem, seqId_);
        current_.pos = posMax < 0 ? 0 : posMax + 1;
        refreshCurrentCacheTokensFromMemory();
      }
      stopGeneration_.store(false);
      return false;
    }
    int32_t res = mtmd_helper_eval_chunk_single(
        visionContext(),
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
  refreshCurrentCacheTokensFromMemory();

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

void MtmdLlmContext::refreshCurrentCacheTokensFromMemory() {
  auto* mem = llama_get_memory(modelCtx_.lctx);
  if (mem == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(ContextSlideFailed),
        "[MtmdLlm] llama memory is null while refreshing cache token count");
  }

  current_.cacheTokens =
      static_cast<llama_pos>(llama_memory_seq_token_count(mem, seqId_));
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
    refreshCurrentCacheTokensFromMemory();
    ++nSlides_;
    // Recorded span positions are no longer valid after the shift;
    // drop them rather than try to fix them up.
    thinkSpan_.reset();
    pendingThinkCloseCapture_ = false;
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
      current_.pos,
      {seqId_},
      true);
  if (llama_decode(modelCtx_.lctx, *batch) != 0) {
    const char* errorMsg = "[MtmdLlm] failed to decode EOT token\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(FailedToDecode), errorMsg);
  }
  ++current_.pos;
  ++current_.cacheTokens;
}

bool MtmdLlmContext::generateResponse(
    const std::function<void(const std::string&)>& outputCallback) {

  int nRemain = params_.n_predict;
  LlamaBatch batch(1, 0, 1); // batch for next token generation

  // Per-inference reset of reasoning detection state. Mirrors
  // TextLlmContext::onPrefillComplete so consecutive generations don't
  // inherit a stale `inside_reasoning` flag or span.
  reasoningState_.inside_reasoning = false;
  reasoningState_.recent_output_buffer.clear();
  thinkSpan_.reset();
  pendingThinkCloseCapture_ = false;

  if (thinkingForcedOpen_) {
    if (outputCallback) {
      outputCallback(thinkingForcedOpenText_);
    }
    // Template force-opened the reasoning channel: the open marker
    // tokens are already in the KV cache from prefill; record their
    // span so `compactThinkSpan` can drop them at end-of-generation.
    if (reasoningEnabled_) {
      setOpenThinkSpan(
          current_.pos -
          static_cast<llama_pos>(reasoningState_.forcedOpenTokenCount));
      reasoningState_.inside_reasoning = true;
    }
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

    // Reasoning channel detection. `current_.pos` here reflects the
    // cache state BEFORE this token is committed (it's incremented after
    // successful decode below), so the open-marker math mirrors
    // TextLlmContext: the first marker piece is at
    // `current_.pos - (openTokenCount - 1)`.
    if (reasoningEnabled_) {
      const bool wasInside = reasoningState_.inside_reasoning;
      qvac_lib_inference_addon_llama::utils::updateReasoningBuffer(
          tokenStr, reasoningState_);
      const bool nowInside = reasoningState_.inside_reasoning;
      if (!wasInside && nowInside) {
        setOpenThinkSpan(
            current_.pos -
            static_cast<llama_pos>(reasoningState_.openTokenCount - 1));
      }
      if (wasInside && !nowInside) {
        // Defer end capture — the close-marker token has not yet been
        // committed to the cache.
        pendingThinkCloseCapture_ = true;
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

    // EOS sampled while still inside the reasoning channel: substitute
    // the cached close marker, decode it so the span end position gets
    // recorded, then exit. Mirrors TextLlmContext single-prompt EOS
    // handling. Without this, `compactThinkSpan()` would skip removal
    // because `thinkSpan_->second` stays unset.
    if (isEos && isQwen3ReasoningFamily_ && reasoningState_.inside_reasoning &&
        reasoningState_.cached_close_tag_token != LLAMA_TOKEN_NULL) {
      tokenId = reasoningState_.cached_close_tag_token;
      tokenStr =
          common_token_to_piece(modelCtx_.lctx, tokenId, params_.special);
      reasoningState_.inside_reasoning = false;
      pendingThinkCloseCapture_ = true;

      if (outputCallback) {
        std::string completeChars = utf8Buffer_.addToken(tokenStr);
        if (!completeChars.empty()) {
          outputCallback(completeChars);
        }
      }

      common_batch_clear(*batch);
      common_batch_add(*batch, tokenId, current_.pos, {seqId_}, true);
      if (llama_decode(modelCtx_.lctx, *batch) != 0) {
        const char* errorMsg =
            "[MtmdLlm] failed to decode substituted reasoning close tag\n";
        throw qvac_errors::StatusError(
            ADDON_ID, toString(FailedToDecode), errorMsg);
      }
      ++current_.pos;
      ++current_.cacheTokens;
      capturePendingThinkClose();
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
    common_batch_add(*batch, tokenId, current_.pos, {seqId_}, true);

    // eval the token
    if (llama_decode(modelCtx_.lctx, *batch) != 0) {
      const char* errorMsg = "[MtmdLlm] failed to decode next token\n";
      throw qvac_errors::StatusError(
          ADDON_ID, toString(FailedToDecode), errorMsg);
    }
    ++current_.pos;
    ++current_.cacheTokens;
    // Close-marker token (if any was sampled this iteration) is now
    // committed; capture the span end.
    capturePendingThinkClose();
  }

  if (nRemain == 0) {
    flushPendingUtf8ToCallback(outputCallback);
  }
  // Drop the reasoning block from the KV cache if the caller opted
  // in and a `<think>...</think>` (or model-equivalent) was emitted.
  compactThinkSpan();
  return true;
}

std::function<void()>
MtmdLlmContext::applyGenerationParams(const GenerationParams& overrides) {
  // Validate the recurrent-memory invariant BEFORE mutating any
  // sampler / common params state. Mirrors TextLlmContext: if the
  // toggle apply later threw on a hybrid SSM model, the partial
  // sampler mutation would leak into subsequent requests.
  if (overrides.remove_thinking_from_context &&
      *overrides.remove_thinking_from_context && hasRecurrentMemory_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "remove_thinking_from_context is not supported on models with "
        "recurrent memory (SSM / hybrid SSM such as Qwen3.5)");
  }

  auto restoreSampler = applyGenerationParamsToContext(
      params_, smpl_, modelCtx_.model, overrides);

  const bool savedRemoveThinking = removeThinkingFromContext_;
  bool toggled = false;
  if (overrides.remove_thinking_from_context) {
    removeThinkingFromContext_ = *overrides.remove_thinking_from_context;
    toggled = true;
  }

  if (!toggled) {
    return restoreSampler;
  }

  return [this,
          restoreSampler = std::move(restoreSampler),
          savedRemoveThinking]() {
    restoreSampler();
    removeThinkingFromContext_ = savedRemoveThinking;
  };
}

void MtmdLlmContext::stop() { stopGeneration_.store(true); }

llama_context* MtmdLlmContext::getCtx() { return modelCtx_.lctx; }

llama_pos MtmdLlmContext::getNPast() const { return current_.pos; }

llama_pos MtmdLlmContext::getKvCellsUsed() const {
  return current_.cacheTokens;
}

void MtmdLlmContext::setNPast(llama_pos nPast) { current_.pos = nPast; }

void MtmdLlmContext::advanceTextSpan(llama_pos newPos) {
  current_.cacheTokens += newPos - current_.pos;
  current_.pos = newPos;
}

// Scheduler-fed generated tokens are decoded by the batcher, not by this
// driver, which learns of them only through syncPosition(). Each generated
// token is text: it advances the logical position and consumes exactly one
// KV cell, so advance both in lockstep. Without this, the per-slot KV-cell
// cap in onLogitsReady() is checked against the frozen prefill count and an
// M-RoPE slot (cacheTokens > pos) can generate past its KV-cell budget.
void MtmdLlmContext::syncPosition(llama_pos currentPos) {
  advanceTextSpan(currentPos);
}

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

int32_t MtmdLlmContext::getThinkingBlockDiscards() const {
  return thinkingBlockDiscards_;
}
void MtmdLlmContext::resetThinkingBlockDiscards() {
  thinkingBlockDiscards_ = 0;
}

void MtmdLlmContext::configureReasoningTags(
    const std::string& thinkingStartTag, const std::string& thinkingEndTag,
    const std::string& forcedOpenText) {
  // Family-default tags act as both the fallback when the active chat
  // template does not expose reasoning tags, and as the source for the
  // Qwen-family single-token close marker used by EOS-inside-reasoning
  // recovery. Resolved once so the lookup runs at most once per
  // prompt render.
  const std::optional<ReasoningTags> fallbackTags =
      selectReasoningTagsForModel(modelCtx_.model);

  const std::optional<ReasoningTags> reasoningTags =
      selectReasoningTagSource(thinkingStartTag, thinkingEndTag, fallbackTags);

  reasoningState_ = ReasoningState{};
  reasoningEnabled_ = false;
  if (!reasoningTags.has_value()) {
    return;
  }

  std::string eosRecoveryCloseTag;
  if (isQwen3ReasoningFamily_ && fallbackTags.has_value()) {
    eosRecoveryCloseTag = fallbackTags->close;
  }

  const bool reasoningInitOk = initializeReasoningState(
      modelCtx_.lctx,
      reasoningState_,
      *reasoningTags,
      forcedOpenText,
      eosRecoveryCloseTag);
  if (reasoningInitOk) {
    reasoningEnabled_ = true;
    return;
  }

  QLOG_IF(
      Priority::WARNING,
      string_format(
          "[MtmdLlm] reasoning detection disabled: first piece of open "
          "marker '%s' is not a special token under this vocab\n",
          reasoningTags->open.c_str()));
}

void MtmdLlmContext::setOpenThinkSpan(llama_pos start) {
  // `start < 0` only for degenerate templates whose entire rendered
  // prompt is the forced-open suffix; drop the span and leave the
  // tokens in cache.
  if (start < 0) {
    return;
  }
  // Single-block policy: only the first `<think>...</think>` is tracked.
  if (thinkSpan_.has_value()) {
    return;
  }
  thinkSpan_ = std::make_pair(start, static_cast<llama_pos>(-1));
}

void MtmdLlmContext::capturePendingThinkClose() {
  if (!pendingThinkCloseCapture_) {
    return;
  }
  pendingThinkCloseCapture_ = false;
  if (!removeThinkingFromContext_ || !thinkSpan_.has_value()) {
    return;
  }
  if (thinkSpan_->second < 0) {
    thinkSpan_->second = current_.pos;
  }
}

void MtmdLlmContext::compactThinkSpan() {
  if (!removeThinkingFromContext_ || !thinkSpan_.has_value()) {
    thinkSpan_.reset();
    return;
  }
  const llama_pos start = thinkSpan_->first;
  const llama_pos end = thinkSpan_->second;
  thinkSpan_.reset();

  if (end < 0 || end <= start) {
    return;
  }

  const CompactRangeOutcome outcome =
      compactKvRange(modelCtx_.lctx, seqId_, start, end, current_.pos);
  if (outcome.kind == CompactRangeOutcome::Kind::Compacted) {
    current_.pos = outcome.newNPast;
    refreshCurrentCacheTokensFromMemory();
    if (start < protectedPrefix_.pos) {
      const llama_pos removedProtectedTokens =
          std::min(outcome.discarded, protectedPrefix_.pos - start);
      protectedPrefix_.pos = start;
      protectedPrefix_.cacheTokens -= removedProtectedTokens;
    }
    if (tools_.enabled()) {
      tools_.onSlide(outcome.discarded, start);
    }
    ++thinkingBlockDiscards_;
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[MtmdLlm] thinking-block compaction: dropped %d tokens "
            "[%d, %d), pos=%d, firstMsgTokens=%d\n",
            outcome.discarded,
            start,
            end,
            current_.pos,
            protectedPrefix_.pos));
  } else if (outcome.kind == CompactRangeOutcome::Kind::MemoryOperationFailed) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[MtmdLlm] thinking-block compaction failed: seqRm rejected "
            "range [%d, %d) (pos=%d, seqId=%d)\n",
            start,
            end,
            current_.pos,
            seqId_));
  }
}

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

  if (visionContext() == nullptr) {
    resetMedia();
    const char* errorMsg = "[MtmdLlm] Vision context is not initialized\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadModel), errorMsg);
  }

  mtmd::bitmap bmp(mtmd_helper_bitmap_init_from_buf(
      visionContext(), media.data(), media.size()));
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

  if (visionContext() == nullptr) {
    resetMedia();
    const char* errorMsg = "[MtmdLlm] Vision context is not initialized\n";
    throw qvac_errors::StatusError(
        ADDON_ID, toString(UnableToLoadModel), errorMsg);
  }

  mtmd::bitmap bmp(
      mtmd_helper_bitmap_init_from_file(visionContext(), fname.c_str()));
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
  bitmaps_.entries.push_back(std::move(bmp));
}

void MtmdLlmContext::resetState(bool resetStats) {

  tools_.reset();
  current_ = {};
  protectedPrefix_ = {};

  // On partial reset (resetStats=false), preserve nSlides_ and
  // thinkingBlockDiscards_ so runtimeStats() can read the per-
  // inference values. On full reset (resetStats=true), clear them
  // along with perf stats.
  if (resetStats) {
    nSlides_ = 0;
    thinkingBlockDiscards_ = 0;
  }

  thinkSpan_.reset();
  pendingThinkCloseCapture_ = false;

  // Clear UTF-8 buffer when resetting state
  utf8Buffer_.clear();
  thinkingForcedOpen_ = false;
  thinkingForcedOpenText_.clear();

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

  if (hasRecurrentMemory_) {
    // TODO: Re-enable tail-token removal for recurrent / hybrid SSM models
    // once QVAC supports llama.cpp sequence checkpoint save + restore. Until
    // then, partial `llama_memory_seq_rm` can fail because recurrent state
    // does not keep full per-token history (for example Qwen3.5 with
    // n_rs_seq=0).
    return 0;
  }

  clearSequenceMemory(modelCtx_.lctx, current_.pos - tokensToRemove, -1);

  current_.pos -= tokensToRemove;
  refreshCurrentCacheTokensFromMemory();

  // Note: The sampler doesn't have an "undo" function, so we leave it as is.
  // The sampler maintains its own history, but the removed tokens won't affect
  // future sampling since they're no longer in the KV cache.

  return tokensToRemove;
}

llama_pos MtmdLlmContext::ctxCeiling() const {
  return perSeqCtxCeiling_ > 0
             ? perSeqCtxCeiling_
             : static_cast<llama_pos>(llama_n_ctx(modelCtx_.lctx));
}

PrefillPlan MtmdLlmContext::preparePrefill(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools,
    const std::vector<std::vector<uint8_t>>& media,
    const std::vector<PlannedMedia>& mediaPlan, bool isCacheLoaded,
    bool isPrefillOnlyRequest) {
  resetMedia();
  validateByteBufferCount(mediaPlan, media.size());
  // Load media in prompt-marker order: byte buffers consume the next hoisted
  // payload from `media` by index, paths load inline. This binds each bitmap
  // to its own marker even when byte and path media interleave.
  for (const auto& step : computeMediaLoadOrder(mediaPlan)) {
    if (step.source == MediaSource::ByteBuffer) {
      loadMedia(media[step.byteIndex]);
    } else {
      loadMedia(step.path);
    }
  }

  mtmd::input_chunks chunks(mtmd_input_chunks_init());
  tokenizeChat(chatMsgs, tools, chunks, isCacheLoaded);

  const size_t nChunks = chunks.size();
  if (nChunks == 0) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(EncoderFailed),
        "[MtmdLlm] preparePrefill: prompt produced no chunks");
  }

  PrefillPlan plan;
  for (size_t i = 0; i < nChunks; i++) {
    const mtmd_input_chunk* chunk = chunks[i];
    if (mtmd_input_chunk_get_type(chunk) == MTMD_INPUT_CHUNK_TYPE_TEXT) {
      size_t nTokens = 0;
      const llama_token* tokens =
          mtmd_input_chunk_get_tokens_text(chunk, &nTokens);
      plan.tokens.insert(plan.tokens.end(), tokens, tokens + nTokens);
    } else {
      plan.mediaBarriers.push_back(
          MediaBarrier{
              .afterTextTokens = plan.tokens.size(),
              .mediaIndex = i,
              .nPos = mtmd_input_chunk_get_n_pos(chunk),
              .nKvTokens = static_cast<llama_pos>(
                  mtmd_input_chunk_get_n_tokens(chunk))});
    }
  }

  // The batcher can only request logits on text tokens it feeds, so a
  // generating request must end on text (chat templates append the
  // generation prompt after the last media item, so this only rejects
  // malformed prompts).
  const bool endsWithMedia =
      !plan.mediaBarriers.empty() &&
      plan.mediaBarriers.back().afterTextTokens == plan.tokens.size();
  if (endsWithMedia && !isPrefillOnlyRequest) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "[MtmdLlm] preparePrefill: prompt must end with text after the "
        "last media item");
  }

  // M-RoPE media spans fewer positions than the KV cells it occupies, so both
  // totals must clear the ceiling independently.
  if (exceedsContextWindow(
          plan.totalPositions(), ctxCeiling(), isPrefillOnlyRequest) ||
      exceedsContextWindow(
          plan.totalKvTokens(), ctxCeiling(), isPrefillOnlyRequest)) {
    std::string errorMsg = string_format(
        "[MtmdLlm] context overflow at batch prefill step: prompt spans %d "
        "positions / %d KV cells, max context tokens %d\n",
        plan.totalPositions(),
        plan.totalKvTokens(),
        ctxCeiling());
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextOverflow), errorMsg);
  }

  // mtmd::input_chunks has a user-declared destructor and therefore no
  // move assignment; transfer the owning pointer directly.
  stagedChunks_.ptr = std::move(chunks.ptr);
  pendingBatchFirstMsg_ = current_.pos == 0;
  return plan;
}

llama_pos MtmdLlmContext::evalMediaSegment(size_t mediaIndex, llama_pos pos) {
  const bool indexInRange =
      stagedChunks_.ptr &&
      mediaIndex < mtmd_input_chunks_size(stagedChunks_.ptr.get());
  const mtmd_input_chunk* chunk =
      indexInRange ? mtmd_input_chunks_get(stagedChunks_.ptr.get(), mediaIndex)
                   : nullptr;
  if (chunk == nullptr) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InternalError),
        "[MtmdLlm] evalMediaSegment: no staged media segment " +
            std::to_string(mediaIndex));
  }

  llama_pos newPos = pos;
  constexpr bool logitsLast = false;
  const int32_t res = mtmd_helper_eval_chunk_single(
      visionContext(),
      modelCtx_.lctx,
      chunk,
      pos,
      seqId_,
      params_.n_batch,
      logitsLast,
      &newPos);
  if (res != 0) {
    std::string errorMsg = string_format(
        "[MtmdLlm] evalMediaSegment: failed to eval media chunk %zu "
        "(res=%d)\n",
        mediaIndex,
        res);
    throw qvac_errors::StatusError(ADDON_ID, toString(EncoderFailed), errorMsg);
  }

  // Commit accounting only after a successful eval, so a throwing/failing
  // eval leaves cacheTokens and pos consistent. Trailing text the scheduler
  // fed since the last driver sync advances positions and KV cells 1:1; the
  // media chunk then adds its own cells on top while positions advance to
  // newPos.
  advanceTextSpan(pos);
  current_.cacheTokens +=
      static_cast<llama_pos>(mtmd_input_chunk_get_n_tokens(chunk));
  current_.pos = newPos;
  return newPos;
}

void MtmdLlmContext::onPrefillComplete(
    llama_pos currentPos, size_t prefillTokenCount) {
  // Trailing text advances positions and KV cells 1:1; media cells were
  // already accounted by evalMediaSegment.
  advanceTextSpan(currentPos);
  if (pendingBatchFirstMsg_) {
    protectedPrefix_ = current_;
    const llama_pos ctxSize = ctxCeiling();
    if (nDiscarded_ >= ctxSize - protectedPrefix_.pos) {
      nDiscarded_ = ctxSize - protectedPrefix_.pos - 1;
    }
    pendingBatchFirstMsg_ = false;
  }
  tools_.onEvalComplete(
      current_.pos, static_cast<llama_pos>(prefillTokenCount));
}

SequenceStepResult MtmdLlmContext::onLogitsReady(
    int logitIdx, unsigned generatedAfterAccept,
    const std::function<void(const std::string&)>& outputCallback,
    LlamaBatch* inlineDecodeBatch) {
  if (stopGeneration_.load()) {
    stopGeneration_.store(false);
    flushPendingUtf8ToCallback(outputCallback);
    const llama_token eot = llama_vocab_eot(modelCtx_.vocab);
    return {
        .token =
            eot == LLAMA_TOKEN_NULL ? llama_vocab_eos(modelCtx_.vocab) : eot,
        .finished = true};
  }

  if ((current_.pos + 1 > ctxCeiling() ||
       current_.cacheTokens + 1 > ctxCeiling()) &&
      nDiscarded_ == 0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[MtmdLlm] generation overflow: per-slot context is full and "
            "nDiscarded is 0 (nPast=%d, cacheTokens=%d, ceiling=%d)\n",
            current_.pos,
            current_.cacheTokens,
            ctxCeiling()));
    return {.finished = true, .contextOverflow = true};
  }
  // No applyContextDiscard here: the batcher's per-sequence cap stops a
  // slot before its window fills, and sliding a sequence that holds
  // media cells would discard image KV entries mid-generation.

  llama_token tokenId =
      common_sampler_sample(smpl_.get(), modelCtx_.lctx, logitIdx);
  common_sampler_accept(smpl_.get(), tokenId, true);

  std::string tokenStr =
      common_token_to_piece(modelCtx_.lctx, tokenId, params_.special);
  const std::string completeChars = utf8Buffer_.addToken(tokenStr);
  if (!completeChars.empty() && outputCallback) {
    outputCallback(completeChars);
  }

  const bool isEos = llama_vocab_is_eog(modelCtx_.vocab, tokenId);
  if (isEos && isHarmonyModel_ && params_.use_jinja &&
      tokenId == harmonyCallToken_) {
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "[MtmdLlm] Harmony <|call|> stop: tokenId=%d\n", tokenId));
    if (outputCallback) {
      const std::string callMarker =
          common_token_to_piece(modelCtx_.lctx, tokenId, true);
      if (!callMarker.empty()) {
        outputCallback(callMarker);
      }
    }
    flushPendingUtf8ToCallback(outputCallback);
    return {.token = tokenId, .finished = true};
  }

  // Batch path only: scheduler stops solely on `finished` (see
  // TextLlmContext::onLogitsReady for the single-prompt rationale).
  const bool reachedBudget =
      inlineDecodeBatch == nullptr && params_.n_predict > 0 &&
      generatedAfterAccept >= static_cast<unsigned>(params_.n_predict);
  const bool finished = isEos || reachedBudget || checkAntiprompt();
  if (finished) {
    flushPendingUtf8ToCallback(outputCallback);
  }
  return {.token = tokenId, .finished = finished};
}

void MtmdLlmContext::onSequenceEnd(
    const std::function<void(const std::string&)>& outputCallback) {
  flushPendingUtf8ToCallback(outputCallback);
}

void MtmdLlmContext::onGenerationFinished(
    const std::function<void(const std::string&)>& outputCallback) {
  onSequenceEnd(outputCallback);
}

void MtmdLlmContext::onCancel(
    const std::function<void(const std::string&)>& outputCallback) {
  onGenerationFinished(outputCallback);
}

void MtmdLlmContext::validatePromptPolicy(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools, const PromptLayout& layout,
    bool hasKvCacheContext) const {
  tools_.validatePrompt(chatMsgs, tools, layout, hasKvCacheContext);
}

/// Prompt caching on the multimodal batch path round-trips the full four-field
/// session-metadata contract (`SessionMetadataField` in LlmContext.hpp),
/// exactly as `CacheManager` does. All four fields are required: copying only
/// the text path's two positional fields would drop
/// `cacheTokens`/`firstMsgCacheTokens`, and for M-RoPE media those KV-cell
/// counts diverge from the positional span (`current_.pos` vs
/// `current_.cacheTokens`), so losing them would break context shifting after
/// restore.
static_assert(
    SESSION_METADATA_FIELD_COUNT == 4,
    "MTMD cache (de)serialization must persist all four session-metadata "
    "fields; update the implementation when the contract changes");

bool MtmdLlmContext::loadCache(
    const std::string& cacheKey, llama_pos configuredNDiscarded) {
  nDiscarded_ = configuredNDiscarded;
  if (cacheKey.empty() || !isFileInitialized(cacheKey)) {
    return false;
  }

  // Restore the full four-field metadata contract (SessionMetadataField order:
  // NPast, FirstMsgTokens, CacheTokens, FirstMsgCacheTokens). For M-RoPE media
  // the KV-cell counts diverge from the positional span, so all four must
  // survive — see the static_assert above. The per-cell llama_kv_cell_ext
  // (x/y) is restored by the GGSQ sequence-state loader itself.
  size_t tokenCount = 0;
  llama_token sessionTokens[SESSION_METADATA_FIELD_COUNT] = {0, 0, 0, 0};
  const auto loadedBytes = llama_state_seq_load_file(
      modelCtx_.lctx,
      cacheKey.c_str(),
      seqId_,
      sessionTokens,
      SESSION_METADATA_FIELD_COUNT,
      &tokenCount);
  if (loadedBytes == 0) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        "MtmdLlmContext::loadCache: failed to load cache '" + cacheKey + "'");
  }

  // `llama_state_seq_load_file` has already restored this sequence's KV cells.
  // Every validation below runs after that restore, and the scheduler installs
  // its per-slot cleanup guard only once this function returns, so any throw in
  // between would strand the restored cells as orphan KV on the slot. Roll the
  // sequence (and the metadata it stamped) back unless we reach the accept
  // point, mirroring `TextLlmContext::loadCache` and `CacheManager::loadCache`.
  ScopeGuard restoredKvGuard([this]() noexcept {
    try {
      clearSequenceMemory(modelCtx_.lctx);
    } catch (...) {
      QLOG_IF(
          Priority::ERROR,
          "[MtmdLlm] failed to clear sequence after invalid cache load\n");
    }
    current_ = {};
    protectedPrefix_ = {};
    tools_.reset();
  });

  // Accepting a partial header would leave `cacheTokens`/`firstMsgCacheTokens`
  // defaulted to zero (they diverge from `nPast` under M-RoPE, breaking later
  // cap checks). Require the full four-field contract; the guard above clears
  // the restored KV on reject, mirroring `CacheManager::loadCache`.
  if (!mtmdSessionMetadataIsComplete(tokenCount)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(UnableToLoadSessionFile),
        "MtmdLlmContext::loadCache: cache '" + cacheKey +
            "' has incomplete session metadata (" + std::to_string(tokenCount) +
            " of " + std::to_string(SESSION_METADATA_FIELD_COUNT) + " fields)");
  }

  setNPast(sessionTokens[static_cast<size_t>(SessionMetadataField::NPast)]);
  setFirstMsgTokens(
      sessionTokens[static_cast<size_t>(SessionMetadataField::FirstMsgTokens)]);
  setCacheTokens(
      sessionTokens[static_cast<size_t>(SessionMetadataField::CacheTokens)]);
  setFirstMsgCacheTokens(
      sessionTokens[static_cast<size_t>(
          SessionMetadataField::FirstMsgCacheTokens)]);

  if (getNPast() > llama_n_ctx(modelCtx_.lctx)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(ContextLengthExeeded),
        "MtmdLlmContext::loadCache: cache '" + cacheKey +
            "' exceeds current context size");
  }

  // Clamp discard to the per-slot window (ctxCeiling), not the physical
  // context, mirroring TextLlmContext::loadCache.
  const llama_pos window = ctxCeiling();
  if (configuredNDiscarded > window - getFirstMsgTokens()) {
    nDiscarded_ = window - getFirstMsgTokens() - 1;
  } else {
    nDiscarded_ = configuredNDiscarded;
  }

  if (auto* mem = llama_get_memory(modelCtx_.lctx); mem != nullptr) {
    llama_memory_seq_rm(mem, seqId_, getNPast(), -1);
  }
  restoredKvGuard.dismiss();
  return true;
}

void MtmdLlmContext::saveCache(const std::string& cacheKey) const {
  if (cacheKey.empty()) {
    return;
  }

  // Persist all four metadata fields in SessionMetadataField order so the
  // physical KV-cell counts that diverge under M-RoPE survive restore.
  const llama_token sessionTokens[SESSION_METADATA_FIELD_COUNT] = {
      static_cast<llama_token>(getNPast()),
      static_cast<llama_token>(getFirstMsgTokens()),
      static_cast<llama_token>(getCacheTokens()),
      static_cast<llama_token>(getFirstMsgCacheTokens())};
  const auto savedBytes = llama_state_seq_save_file(
      modelCtx_.lctx,
      cacheKey.c_str(),
      seqId_,
      sessionTokens,
      SESSION_METADATA_FIELD_COUNT);
  if (savedBytes == 0) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidInputFormat),
        "MtmdLlmContext::saveCache: failed to save cache '" + cacheKey + "'");
  }
}
