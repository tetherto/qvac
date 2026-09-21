#include "fit/FitResultContext.hpp"

namespace model_fit::detail {

void finalizeFitContext(FitResult& result, uint32_t trainedCtx) {
  if (result.fits && result.nCtx == 0) {
    if (trainedCtx > 0) {
      result.nCtx = trainedCtx;
    } else {
      result.status = 2;
      result.fits = false;
      result.reason = FitReason::ModelUnreadable;
      // ERROR carries no projection; the probe may already have run.
      result.projection.clear();
    }
  }
}

} // namespace model_fit::detail
