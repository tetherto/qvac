#include "src/model-interface/IPiperEngine.hpp"
#include "gmock/gmock.h"
#include "gtest/gtest.h"

namespace qvac::ttslib::piper::testing {

class PiperEngineMock : public piper::IPiperEngine {
public:
  PiperEngineMock() = default;
  ~PiperEngineMock() = default;

  MOCK_METHOD(void, load, (const TTSConfig& cfg), (override));
  MOCK_METHOD(void, unload, (), (override));
  MOCK_METHOD(AudioResult, synthesize, (const std::string& text), (override));
};

} // namespace qvac::ttslib::piper::testing
