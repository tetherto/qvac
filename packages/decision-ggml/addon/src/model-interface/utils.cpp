#include "utils.hpp"

#include <algorithm>
#include <charconv>
#include <system_error>
#include <thread>

#if defined(__unix__) || defined(__APPLE__)
#include <unistd.h>
#endif

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>

#include "addon/DecisionErrors.hpp"

using namespace qvac_lib_inference_addon_decision::errors;

bool isThreadsKey(const std::string& key) {
  return key == "threads" || key == "threads-batch" || key == "threads_batch";
}

namespace {

// CPUs the device has. hardware_concurrency() counts the online ones, which
// Android lowers when it parks cores, so take the configured count when larger.
unsigned cpuCount() {
  unsigned cpus = std::thread::hardware_concurrency();
#if defined(_SC_NPROCESSORS_CONF)
  const long configured = sysconf(_SC_NPROCESSORS_CONF);
  if (configured > 0) {
    cpus = std::max(cpus, static_cast<unsigned>(configured));
  }
#endif
  return cpus;
}

} // namespace

// A whole number, at most the CPU count; 0 or below means every CPU. More
// threads than CPUs only slows a pass down, because ggml's workers wait on
// spinning barriers: on 10 CPUs, 16 threads took about 11x as long as 10, and
// 128 did not finish within a minute.
void checkThreads(const std::string& key, const std::string& value) {
  long long threads = 0;
  const char* end = value.data() + value.size();
  const auto [ptr, ec] = std::from_chars(value.data(), end, threads);
  if (ec == std::errc::result_out_of_range) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        string_format(
            "%s: '%s' is out of range: '%s'",
            __func__,
            key.c_str(),
            value.c_str()));
  }
  if (ec != std::errc() || ptr != end) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        string_format(
            "%s: '%s' must be a whole number, got '%s'",
            __func__,
            key.c_str(),
            value.c_str()));
  }
  const unsigned cpus = cpuCount();
  if (threads > 0 && cpus > 0 && threads > static_cast<long long>(cpus)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        toString(InvalidConfiguration),
        string_format(
            "%s: '%s' is %lld, but this device has %u CPUs; use at most %u, "
            "or 0 for all of them",
            __func__,
            key.c_str(),
            threads,
            cpus,
            cpus));
  }
}

void checkLoadOptions(
    const std::unordered_map<std::string, std::string>& config,
    const std::unordered_set<std::string>& allowed, const char* caller,
    const char* model, const char* accepted) {
  for (const auto& [key, value] : config) {
    if (!allowed.contains(key)) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          toString(InvalidConfiguration),
          string_format(
              "%s: '%s' is not a %s load option; accepted: %s",
              caller,
              key.c_str(),
              model,
              accepted));
    }
    if (isThreadsKey(key)) {
      checkThreads(key, value);
    }
  }
}
