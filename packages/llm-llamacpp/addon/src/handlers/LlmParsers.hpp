#pragma once

#include <string_view>

namespace qvac_lib_inference_addon_llama::parsers {

// Per-request reasoning_budget override (JS number): -1/0/positive. Throws on
// fractional, below -1, or above INT_MAX.
int validateReasoningBudgetOverride(double raw);

// Load-time reasoning-budget (string): -1/0/positive. Throws on non-integer or
// below -1.
int parseReasoningBudgetConfig(std::string_view raw);

} // namespace qvac_lib_inference_addon_llama::parsers
