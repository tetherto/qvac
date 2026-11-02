#pragma once
#include <cstddef>
#include <string_view>

namespace qvac_lib_inference_addon_llama::utils {

/// Deepest array/object nesting accepted in request JSON. picojson, fabric's
/// `json_schema_to_grammar` and the chat templates take a few stack frames per
/// level; on a 512 KB thread stack, the macOS and iOS worker default, fabric
/// overflows past 512 levels. A `tool_calls` arguments string is checked on
/// its own, so the template sees it a few levels deeper. Not bounded: the
/// schema converter recursing per `$ref` link or copying the schema per
/// `type`-array entry.
inline constexpr size_t K_MAX_JSON_DEPTH = 128;

/// Whether arrays and objects in @p json nest deeper than K_MAX_JSON_DEPTH.
/// Brackets inside strings are skipped.
inline bool nestsTooDeep(std::string_view json) {
  size_t depth = 0;
  bool inString = false;
  bool escaped = false;
  for (const char c : json) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c == '\\') {
        escaped = true;
      } else if (c == '"') {
        inString = false;
      }
    } else if (c == '"') {
      inString = true;
    } else if (c == '[' || c == '{') {
      if (++depth > K_MAX_JSON_DEPTH) {
        return true;
      }
    } else if ((c == ']' || c == '}') && depth > 0) {
      --depth;
    }
  }
  return false;
}

} // namespace qvac_lib_inference_addon_llama::utils
