#pragma once

#include <cstdint>

#include "fit/FitParams.hpp"

namespace model_fit::detail {

void finalizeFitContext(FitResult& result, uint32_t trainedCtx);

} // namespace model_fit::detail
