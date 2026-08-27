#pragma once

#include <optional>
#include <string>

// Per-request values the chat-template render needs, as opposed to the
// sampler overrides in `GenerationParams`. Set on the context before prefill
// (single path: `LlamaModel::processPromptImpl`, cleared with the sampler
// restore; batch path: `ContinuousBatchScheduler::submitLocked`, dies with
// the slot driver). Lives in its own header because both `LlmContext` and
// `SequenceDriver` consume it and `LlmContext.hpp` includes
// `SequenceDriver.hpp`.
struct RenderOverrides {
  // Raw JSON Schema string. With tools present it is handed to the template so
  // the tool-call grammar and the response schema compose into one grammar.
  std::optional<std::string> jsonSchema;
  // "auto" | "none" | "required" | <declared function name>.
  std::optional<std::string> toolChoice;
};
