#include "test_logger.hpp"

#include <thread>

#include "qvac-lib-inference-addon-cpp/JsInterface.hpp"
#include "qvac-lib-inference-addon-cpp/Logger.hpp" //For QLOG test only

class TestLogger {
};

using JsIfTestLogger = qvac_lib_inference_addon_cpp::JsInterface<TestLogger>;

namespace js = qvac_lib_inference_addon_cpp::js;
namespace logger = qvac_lib_inference_addon_cpp::logger;

// Specialization of JsInterface methods
namespace qvac_lib_inference_addon_cpp {
}

namespace test_logger {
  auto setLogger(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
    return JsIfTestLogger::setLogger(env, info);
  }

  auto cppLog(js_env_t* env, js_callback_info_t* info) -> js_value_t* try {
    auto args = js::getArguments(env, info);
    if (args.size() != 2) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "Expected (priority: number, message: string)");
    }
    int32_t pri = 0;
    JS(js_get_value_int32(env, args[0], &pri));
    auto msg = js::String::fromValue(args[1]).as<std::string>(env);

    logger::JsLogger::log(static_cast<logger::Priority>(pri), msg);
    //QLOG(pri, msg);

    return nullptr;
  } JSCATCH

  auto dummyCppLogWork(js_env_t * /*env*/, js_callback_info_t* /*info*/) -> js_value_t* {
    logger::JsLogger::log(logger::Priority::DEBUG, "hello from C++");
    return nullptr;
  }

  auto dummyMultiThreadedCppLogWork(js_env_t * /*env*/, js_callback_info_t* /*info*/) -> js_value_t* {
    auto threadFunction = [](int /*id*/) {
      constexpr int K_ITERATIONS = 10;
      for (auto i = 0; i < K_ITERATIONS; ++i) {
        //std::cout << "Thread " << id << " is running.\n";
        logger::JsLogger::log(logger::Priority::DEBUG, "hello from C++");
        //std::cout << "Thread " << id << " finished work.\n";
      }
    };

    std::vector<std::thread> threads;
    threads.reserve(4);
    for (int i = 0; i < 4; ++i) {
      threads.emplace_back(threadFunction, i);
    }
    for (auto &thread: threads) {
      thread.join();
    }

    return nullptr;
  }

  auto releaseLogger(js_env_t *env, js_callback_info_t *info) -> js_value_t* {
    return JsIfTestLogger::releaseLogger(env, info);
  }
}
