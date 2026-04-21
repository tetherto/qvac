#pragma once
#include <string>

namespace {{CPP_NAMESPACE}} {

class HelloWorld {
 public:
  static std::string greet(const std::string& name) {
    return "hello, " + name;
  }
};

} // namespace {{CPP_NAMESPACE}}
