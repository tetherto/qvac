#include <type_traits>

#include "model-interface/EngineOptions.hpp"

#ifdef AUDIOGEN_HAS_MINIMAX
#error "ACE-Step-only coverage must not enable MiniMax"
#endif

static_assert(std::is_same_v<
              decltype(qvac::audiogenggml::engineOptions(
                  qvac::audiogenggml::acestep::AcestepConfig{})),
              tts_cpp::acestep::EngineOptions>);
