#pragma once

#include "ggml-backend.h"
#include "ggml.h"
#include "nmt.hpp"

struct ggml_cgraph* nmt_build_graph_encoder(nmt_context& ctx, nmt_state& state);

struct ggml_cgraph* nmt_build_graph_cross(nmt_context& ctx, nmt_state& state);

bool nmt_encode_internal(nmt_context& ctx, nmt_state& state);
