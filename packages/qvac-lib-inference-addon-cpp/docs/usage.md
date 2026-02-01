# Usage Guide

This guide covers how to build new addons using `qvac-lib-inference-addon-cpp`.

## Table of Contents

- [Building an Addon (C++ Developer Guide)](#building-an-addon-c-developer-guide)
  - [Implementing the Model Interface](#implementing-the-model-interface)
  - [JavaScript Addon Creation](#javascript-addon-creation)
  - [Implementing runJob](#implementing-runjob)
  - [Exporting JavaScript Bindings](#exporting-javascript-bindings)
  - [C++ Addon Creation](#c-addon-creation)

## Building an Addon (C++ Developer Guide)

This section shows how to build a new inference addon using `qvac-lib-inference-addon-cpp`.

### Implementing the Model Interface

Your model must implement the `model::IModel` interface with a `process(std::any)` method:

```cpp
#include <qvac-lib-inference-addon-cpp/ModelInterfaces.hpp>

class MyModel : public model::IModel {
public:
  std::string getName() const override {
    return "MyModel";
  }
  
  RuntimeStats runtimeStats() const override {
    return {}; // Return performance stats
  }
  
  std::any process(const std::any& input) override {
    auto text = std::any_cast<std::string>(input);
    std::string result = doInference(text);
    return std::any(result);
  }
  
  // Optional: Implement IModelAsyncLoad for streaming weights
  // Optional: Implement IModelCancel for job cancellation
};
```

### JavaScript Addon Creation

For JavaScript integration, use `AddonJs` which wraps `AddonCpp`:

```cpp
#include <qvac-lib-inference-addon-cpp/addon/AddonJs.hpp>
#include <qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp>
#include <qvac-lib-inference-addon-cpp/queue/OutputCallbackJs.hpp>

namespace my_addon {
  using namespace qvac_lib_inference_addon_cpp;
  
  inline js_value_t* createInstance(js_env_t* env, js_callback_info_t* info) {
    JsArgsParser args(env, info);
    
    // Set up JavaScript output handlers
    out_handl::OutputHandlers<out_handl::JsOutputHandlerInterface> outHandlers;
    outHandlers.add(std::make_shared<out_handl::JsStringOutputHandler>());
    
    // Create JavaScript output callback
    auto outputCallback = std::make_unique<OutputCallBackJs>(
        env,
        args.get(0, "jsHandle"),
        args.getFunction(2, "outputCallback"),
        args.get(3, "transitionCb"),
        std::move(outHandlers)
    );
    
    // Create model with config from JS
    auto model = std::make_unique<MyModel>(
        args.getMapEntry(1, "path"),
        args.getSubmap(1, "config")
    );
    
    // Create AddonJs
    auto addon = std::make_unique<AddonJs>(
        env,
        std::move(outputCallback),
        std::move(model)
    );
    
    return JsInterface::createInstance(env, std::move(addon));
  }
}
```

**Available JavaScript Output Handlers:**

- **`JsStringOutputHandler`** - Converts `std::string` to JavaScript string
- **`JsTypedArrayOutputHandler<T>`** - Converts `std::vector<T>` to JavaScript typed arrays
- **`Js2DArrayOutputHandler<ContainerT, T>`** - Converts 2D containers to JavaScript 2D arrays

To implement a custom JavaScript output handler, extend `BaseOutputHandler<js_value_t*, YourOutputType>` and implement the conversion from your C++ type to a JavaScript value. See `src/qvac-lib-inference-addon-cpp/handlers/JsOutputHandlerImplementations.hpp` for examples.

### Implementing runJob

The `runJob` function must be implemented by your addon to parse JavaScript input and convert it to the `std::any` your model expects:

```cpp
inline js_value_t* runJob(js_env_t* env, js_callback_info_t* info) {
  JsArgsParser args(env, info);
  AddonJs& instance = JsInterface::getInstance(env, args.get(0, "instance"));
  
  // Parse JS input into your model's expected type
  js::Object inputObj(env, args.get(1, "input"));
  std::string text = inputObj.getPropertyAs<js::String, std::string>(env, "input");
  
  // Run the job with input wrapped in std::any
  instance.addonCpp->runJob(std::any(std::move(text)));
  return nullptr;
}
```
### Exporting JavaScript Bindings

Export your addon methods. Note that `createInstance` and `runJob` are addon-specific, while other methods use the provided `JsInterface`:

```cpp
#include <qvac-lib-inference-addon-cpp/JsInterface.hpp>

using JsAPI = qvac_lib_inference_addon_cpp::JsInterface;

static js_module_t* init(js_env_t* env, js_value_t* exports) {
  js_define_methods(env, exports, {
    // Addon-specific implementations
    {"createInstance", my_addon::createInstance},
    {"runJob", my_addon::runJob},
    
    // Provided by JsInterface
    {"activate", JsAPI::activate},
    {"destroyInstance", JsAPI::destroyInstance},
    {"setLogger", JsAPI::setLogger},
    {"releaseLogger", JsAPI::releaseLogger}

    // Optionally include cancel and loadWeights bindings if needed:
    // {"cancel", JsAPI::cancel},
    // {"loadWeights", JsAPI::loadWeights},
  });
  return NULL;
}

BARE_MODULE(my_addon, init)
```

### C++ Addon Creation

You can create a pure C++ addon for CLI usage or testing by using C++ implementations of the callback and output handlers. See `tests/simple_addon_test.cpp` for an example configuration.
