// voiceControlsCatalog() (addon/VoiceControlsCatalog.hpp): the snapshot the
// binding's getVoiceControls() serialises must mirror tts-cpp's own queries.

#include <algorithm>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <tts-cpp/voice_controls.h>

#include "addon/VoiceControlsCatalog.hpp"

using qvac::ttsggml::EngineVoiceControls;
using qvac::ttsggml::voiceControlsCatalog;

namespace {

const EngineVoiceControls* findEngine(
    const std::vector<EngineVoiceControls>& engines, const std::string& name) {
  const auto it = std::find_if(
      engines.begin(), engines.end(), [&name](const EngineVoiceControls& e) {
        return e.engine == name;
      });
  return it == engines.end() ? nullptr : &*it;
}

bool contains(const std::vector<std::string>& values, const std::string& v) {
  return std::find(values.begin(), values.end(), v) != values.end();
}

} // namespace

TEST(VoiceControlsCatalog, MirrorsTheCanonicalVocabulary) {
  const auto catalog = voiceControlsCatalog();
  EXPECT_EQ(catalog.emotions, tts_cpp::controls::all_emotions());
  EXPECT_EQ(catalog.paces, tts_cpp::controls::all_paces());
  EXPECT_TRUE(contains(catalog.paces, "moderate"));
}

TEST(VoiceControlsCatalog, ListsEveryEngineInDeclarationOrder) {
  const auto catalog = voiceControlsCatalog();
  const auto& ids = tts_cpp::controls::all_engines();
  ASSERT_EQ(catalog.engines.size(), ids.size());
  for (size_t i = 0; i < ids.size(); ++i) {
    EXPECT_EQ(
        catalog.engines[i].engine, tts_cpp::controls::engine_name(ids[i]));
    EXPECT_EQ(
        catalog.engines[i].emotions,
        tts_cpp::controls::supported_emotions(ids[i]));
    EXPECT_EQ(
        catalog.engines[i].paces, tts_cpp::controls::supported_paces(ids[i]));
  }
}

TEST(VoiceControlsCatalog, EngineSubsetsStayInsideTheVocabulary) {
  const auto catalog = voiceControlsCatalog();
  for (const auto& engine : catalog.engines) {
    for (const auto& emotion : engine.emotions) {
      EXPECT_TRUE(contains(catalog.emotions, emotion))
          << engine.engine << " emotion " << emotion;
    }
    for (const auto& pace : engine.paces) {
      EXPECT_TRUE(contains(catalog.paces, pace))
          << engine.engine << " pace " << pace;
    }
  }
}

TEST(VoiceControlsCatalog, CoversTheAddonEngines) {
  const auto catalog = voiceControlsCatalog();
  for (const char* name :
       {"parler", "cosyvoice", "supertonic", "chatterbox", "audio8"}) {
    EXPECT_NE(findEngine(catalog.engines, name), nullptr) << name;
  }
  const auto* supertonic = findEngine(catalog.engines, "supertonic");
  ASSERT_NE(supertonic, nullptr);
  EXPECT_TRUE(supertonic->emotions.empty());
  EXPECT_FALSE(supertonic->paces.empty());
}
