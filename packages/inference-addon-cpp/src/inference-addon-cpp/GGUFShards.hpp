#pragma once

#include <filesystem>
#include <iomanip>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

#include "Logger.hpp"

struct GGUFShards {
  std::string tensors_file;
  std::vector<std::string> gguf_files;

  /// @returns List of all shards if the file path correspond to a sharded model
  /// or an empty vector if it is not a sharded model.
  /// @note Also includes the `*tensors.txt` file.
  /// @param base_model_path Path to the base model file, for example
  /// `path/SmolLM2-135M-Instruct-IQ3_XS-00001-of-00002.gguf`.
  static inline GGUFShards expandGGUFIntoShards(std::string base_model_path) {
    GGUFShards shards;

    std::filesystem::path path(base_model_path);
    std::string filename = path.filename().string();

    auto invalidShards = [&base_model_path]() {
      QLOG(
          qvac_lib_inference_addon_cpp::logger::Priority::ERROR,
          "Invalid sharded file (expected five-digit shard numbers with "
          "1 <= shard <= total <= 99999): " +
              base_model_path);
      return GGUFShards{};
    };

    std::regex pattern(R"(^(.+)-(\d{5})-of-(\d{5})\.gguf$)");
    std::smatch matches;

    if (!std::regex_match(filename, matches, pattern)) {
      if (std::regex_match(filename, std::regex(R"(^.+-\d+-of-\d+\.gguf$)"))) {
        return invalidShards();
      }
      return shards;
    }

    std::string basename = matches[1].str();
    std::string totalShards = matches[3].str();

    int totalShardsNum;
    int currentShardNum;
    try {
      totalShardsNum = std::stoi(totalShards);
      currentShardNum = std::stoi(matches[2].str());
    } catch (...) {
      return invalidShards();
    }

    if (totalShardsNum < 1 || totalShardsNum > 99999 || currentShardNum < 1 ||
        currentShardNum > totalShardsNum) {
      return invalidShards();
    }

    shards.tensors_file = basename + ".tensors.txt";

    for (int i = 1; i <= totalShardsNum; i++) {
      std::stringstream ss;
      ss << basename << "-" << std::setfill('0') << std::setw(5) << i << "-of-"
         << std::setfill('0') << std::setw(5) << totalShardsNum << ".gguf";
      shards.gguf_files.push_back(ss.str());
    }

    return shards;
  }
};
