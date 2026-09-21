#include "fit/FitResultContext.hpp"

#include <iostream>

namespace {

model_fit::FitResult fittedWithZeroContext() {
  model_fit::FitResult result;
  result.status = 0;
  result.fits = true;
  result.reason = model_fit::FitReason::Fits;
  result.nCtx = 0;
  result.projection.push_back({"MTL0", 1, 1, 1, 1, 1, 1});
  result.projection.push_back({"host", 1, 1, 1, 1, 1, 1});
  return result;
}

} // namespace

int main() {
  {
    model_fit::FitResult result = fittedWithZeroContext();
    model_fit::detail::finalizeFitContext(result, 0);

    if (result.status != 2 || result.fits ||
        result.reason != model_fit::FitReason::ModelUnreadable) {
      std::cerr << "missing trained context must produce "
                   "ERROR/model-unreadable\n";
      return 1;
    }
    if (!result.projection.empty()) {
      std::cerr << "a downgrade to ERROR must drop the projection\n";
      return 1;
    }
  }

  {
    model_fit::FitResult result = fittedWithZeroContext();
    model_fit::detail::finalizeFitContext(result, 4096);

    if (result.status != 0 || !result.fits || result.nCtx != 4096) {
      std::cerr << "a readable trained context must fill nCtx and keep "
                   "SUCCESS\n";
      return 1;
    }
    if (result.projection.size() != 2) {
      std::cerr << "a SUCCESS must keep its projection\n";
      return 1;
    }
  }

  return 0;
}
