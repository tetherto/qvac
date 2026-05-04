#pragma once

#include "ggml-backend.h"
#include "ggml.h"
#include "nmt.hpp"

struct ggml_cgraph* nmtBuildGraphEncoder(nmt_context& ctx, nmt_state& state);

struct ggml_cgraph* nmtBuildGraphCross(nmt_context& ctx, nmt_state& state);

bool nmtEncodeInternal(nmt_context& ctx, nmt_state& state);
