#include "ContextShifter.hpp"

#include <string>

#include <common/common.h>
#include <llama.h>

#include "../utils/LoggingMacros.hpp"
#include "../utils/ReasoningRollbackState.hpp"
#include "ContextSlider.hpp"
#include "ReasoningBlockCompactor.hpp"
#include "ToolsCompactController.hpp"
#include "addon/LlmErrors.hpp"
#include "inference-addon-cpp/Errors.hpp"
#include "inference-addon-cpp/Logger.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;
using namespace qvac_lib_inference_addon_llama::errors;

namespace qvac_lib_inference_addon_llama {

ContextShifter::ContextShifter(
    ReasoningBlockCompactor& compactor, utils::ReasoningRollbackState& rollback)
    : compactor_(compactor), rollback_(rollback) {}

ContextShifter::Outcome ContextShifter::applyGenerationDiscard(
    ::llama_context* ctx, llama_seq_id seqId, llama_pos pos,
    llama_pos protectedPrefixPos, llama_pos effectiveCtx, llama_pos cacheTokens,
    const char* labelTag, const IContextSliderOps& ops) {
  // Slide notification is routed through the compactor's tools
  // controller so we keep a single tools reference per inference.
  auto outcome = trySlideGeneration(
      ctx,
      seqId,
      pos,
      protectedPrefixPos,
      nDiscarded_,
      compactor_.toolsController(),
      ops,
      effectiveCtx,
      cacheTokens);

  Outcome out;
  if (outcome.kind == ContextSlideOutcome::Kind::Slid) {
    out.kind = Outcome::Kind::Slid;
    out.newPos = outcome.newNPast;
    out.discarded = outcome.discarded;
    ++nSlides_;
    // Recorded span positions are no longer valid after the shift. If a
    // reasoning span was active, mark final compaction as a strict failure
    // rather than silently dropping the stale coordinates. For generated-opener
    // recurrent paths, a boundary snapshot can exist before `<think>` is
    // detected; remember that the boundary was invalidated so a later opener
    // hard-fails instead of becoming an untracked no-op. Otherwise clear any
    // pending close-capture state left over from earlier detection.
    if (compactor_.hasOpenSpan()) {
      compactor_.markSpanInvalidatedByGenerationSlide(pos, outcome.discarded);
    } else if (rollback_.hasReasoningBoundary()) {
      compactor_.markBoundaryInvalidatedByGenerationSlide(
          pos, outcome.discarded);
      compactor_.clearSpan();
    } else {
      compactor_.clearSpan();
    }
    rollback_.clearReasoningBoundary();
    rollback_.clearPostReasoning();
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "%s discarded %d tokens after the first message\n",
            labelTag,
            outcome.discarded));
  } else if (outcome.kind == ContextSlideOutcome::Kind::MemoryOperationFailed) {
    std::string errorMsg = string_format(
        "%s failed to slide context memory during generation "
        "(nPast=%d, nDiscarded=%d)\n",
        labelTag,
        pos,
        nDiscarded_);
    throw qvac_errors::StatusError(
        ADDON_ID, toString(ContextSlideFailed), errorMsg);
  }
  return out;
}

} // namespace qvac_lib_inference_addon_llama
