#pragma once
#include <string>

namespace qvac_lib_infer_vla {

class HelloWorld {
 public:
  static std::string greet(const std::string& name) {
    return "hello, " + name;
  }
};

} // namespace qvac_lib_infer_vla
