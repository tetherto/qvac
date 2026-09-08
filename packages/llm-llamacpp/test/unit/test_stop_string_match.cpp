// Coverage for the shared stop-string matcher both LLM contexts call from
// `checkAntiprompt`. The property under test is the asymmetry between the two
// stop lists: caller antiprompts fold case, template delimiters do not.
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "utils/StopStringMatch.hpp"

using qvac_lib_inference_addon_llama::utils::matchesAnyStopString;
using qvac_lib_inference_addon_llama::utils::toLowerAscii;

namespace {

// The delimiter fabric's PEG auto-parser pushes into `additional_stops` for
// laguna_glm_thinking templates — the one real template stop this package
// has met, and the reason the case rule matters.
constexpr const char* ASSISTANT_CLOSE = "</assistant>";

std::vector<std::string> lowered(const std::vector<std::string>& values) {
  std::vector<std::string> out;
  out.reserve(values.size());
  for (const std::string& value : values) {
    out.push_back(toLowerAscii(value));
  }
  return out;
}

} // namespace

TEST(StopStringMatchTest, EmptyListsNeverMatch) {
  EXPECT_FALSE(matchesAnyStopString("anything at all", {}, {}));
  EXPECT_FALSE(matchesAnyStopString("", {}, {}));
}

// A template stop is a protocol delimiter, so it matches only the bytes the
// template actually emits. Folding it would let a model discussing the tag in
// upper case truncate its own answer on a delimiter that was never produced.
TEST(StopStringMatchTest, TemplateStopDoesNotMatchACaseVariant) {
  const std::vector<std::string> templateStops{ASSISTANT_CLOSE};
  EXPECT_FALSE(matchesAnyStopString(
      "the closing tag is spelled </ASSISTANT> in this document",
      {},
      templateStops));
  EXPECT_FALSE(
      matchesAnyStopString("mixed case </Assistant> here", {}, templateStops));
}

TEST(StopStringMatchTest, TemplateStopMatchesExactBytes) {
  const std::vector<std::string> templateStops{ASSISTANT_CLOSE};
  EXPECT_TRUE(
      matchesAnyStopString("done talking</assistant>", {}, templateStops));
  // Scanned across the whole window, not just its tail: one token can decode
  // to many characters, so a delimiter can sit mid-window.
  EXPECT_TRUE(matchesAnyStopString(
      "done</assistant> and then some trailing text", {}, templateStops));
}

// The load-time antiprompt behaviour is unchanged, and that is half the point
// of the fix: only the template list stopped folding.
TEST(StopStringMatchTest, AntipromptsStillMatchCaseInsensitively) {
  const std::vector<std::string> antiprompts = lowered({"User:"});
  EXPECT_TRUE(matchesAnyStopString("... USER:", antiprompts, {}));
  EXPECT_TRUE(matchesAnyStopString("... user:", antiprompts, {}));
  EXPECT_TRUE(matchesAnyStopString("... UsEr:", antiprompts, {}));
  EXPECT_FALSE(matchesAnyStopString("... assistant:", antiprompts, {}));
}

// Both lists are consulted, and each keeps its own rule when they are used
// together — the arrangement `checkAntiprompt` actually passes in.
TEST(StopStringMatchTest, ListsKeepTheirOwnRulesWhenCombined) {
  const std::vector<std::string> antiprompts = lowered({"User:"});
  const std::vector<std::string> templateStops{ASSISTANT_CLOSE};

  EXPECT_TRUE(matchesAnyStopString("... USER:", antiprompts, templateStops))
      << "the antiprompt still folds when a template stop is present";
  EXPECT_TRUE(
      matchesAnyStopString("...</assistant>", antiprompts, templateStops));
  EXPECT_FALSE(
      matchesAnyStopString("...</ASSISTANT>", antiprompts, templateStops))
      << "the template stop must not borrow the antiprompt's case rule";
}

// Byte-wise matching, so a multibyte delimiter survives intact. `toLowerAscii`
// leaves bytes >= 0x80 alone for this reason; a locale-dependent fold could
// corrupt one and stop matching a delimiter the template does emit.
TEST(StopStringMatchTest, MultibyteStopsMatchUnchanged) {
  const std::vector<std::string> templateStops{"⟨end⟩"};
  EXPECT_TRUE(matchesAnyStopString("finished ⟨end⟩", {}, templateStops));
  EXPECT_FALSE(matchesAnyStopString("finished ⟨END⟩", {}, templateStops));
}
