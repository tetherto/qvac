#include "fit/FitResultContext.hpp"

#include <iostream>

int main() {
  model_fit::FitResult result;
  result.status = 0;
  result.fits = true;
  result.reason = model_fit::FitReason::Fits;
  result.nCtx = 0;

  model_fit::detail::finalizeFitContext(result, 0);

  if (result.status != 2 || result.fits ||
      result.reason != model_fit::FitReason::ModelUnreadable) {
    std::cerr << "missing trained context must produce "
                 "ERROR/model-unreadable\n";
    return 1;
  }

  return 0;
}
