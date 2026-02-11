#include "src/model-interface/IChatterboxEngine.hpp"
#include "gmock/gmock.h"
#include "gtest/gtest.h"

namespace qvac::ttslib::chatterbox::testing {

class ChatterboxEngineMock : public chatterbox::IChatterboxEngine {
public:
  ChatterboxEngineMock() = default;
  ~ChatterboxEngineMock() = default;

  MOCK_METHOD(void, load, (const ChatterboxConfig& cfg), (override));
  MOCK_METHOD(void, unload, (), (override));
  MOCK_METHOD(bool, isLoaded, (), (const, override));
  MOCK_METHOD(AudioResult, synthesize, (const std::string& text), (override));
};

} // namespace qvac::ttslib::chatterbox::testing
