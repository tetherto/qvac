#include <fstream>
#include <iostream>
#include <sstream>
#include <unordered_map>

#include <picojson/picojson.h>

#include "model-interface/LlamaModel.hpp"

std::string prompt_with_tool = R"([
  {
    "role": "system",
    "content": "You are a helpful assistant."
  },
  {
    "role": "user",
    "content": "what is the weather in Tokyo and London?"
  },
  {
    "type": "function",
    "name": "getCityForecast",
    "description": "Fetches the weather forecast for a specific city in a given country.",
    "parameters": {
      "type": "object",
      "properties": [
        {
          "name": "cityName",
          "type": "string",
          "description": "The name of the city for which to fetch the forecast"
        },
        {
          "name": "countryCode",
          "type": "string",
          "description": "The ISO country code corresponding to the country."
        }
      ],
      "required": [
        "cityName",
        "countryCode"
      ]
    }
  }
])";

int main(int argc, char* argv[]) {
  std::string model_path;
  std::string projector_path = ""; // Default: empty for text-only models
  std::string device = "gpu";      // Default: GPU

  if (argc < 2) {
    std::cerr << "Usage: " << (argc > 0 ? argv[0] : "cli_tool")
              << " <model_path> [projector_model_path] [--cpu]\n";
    std::cerr << "  <model_path>           Path to the model file           "
                 "(required)\n";
    std::cerr << "  [projector_model_path] Path to the projector model file "
                 "(optional)\n";
    std::cerr << "  [--cpu]                Use CPU instead of GPU           "
                 "(optional, default: gpu)\n";
    return 1;
  }

  // Parse arguments
  model_path = argv[1];

  // Check for --cpu flag and collect non-flag arguments
  bool cpu_flag = false;
  for (int i = 2; i < argc; i++) {
    std::string arg = argv[i];
    if (arg == "--cpu") {
      cpu_flag = true;
    } else if (projector_path.empty()) {
      // First non-flag argument after model_path is projector_path
      projector_path = arg;
    }
  }

  if (cpu_flag) {
    device = "cpu";
  }

  // Example config map - adjust as needed for your model
  std::unordered_map<std::string, std::string> config_files;
  config_files["device"] = device;
  config_files["jinja"] = ""; // enable jinja to support tool calls in the
                              // prompt
  config_files["ctx_size"] = "8124";
  config_files["gpu_layers"] = "99";
  try {
    // Create LlamaModel instance with the correct constructor
    LlamaModel model(model_path, projector_path, config_files);

    model.waitForLoadInitialization();

    // Process the prompt with json
    std::cout << "--------------Prompt------------" << "\n";
    std::cout << prompt_with_tool << "\n";
    std::string out = model.process(prompt_with_tool);
    std::cout << "--------------Answer------------" << "\n";
    std::cout << out << "\n";

  } catch (const std::exception& e) {
    std::cerr << "Error: " << e.what() << std::endl;
    return 1;
  }

  return 0;
}
