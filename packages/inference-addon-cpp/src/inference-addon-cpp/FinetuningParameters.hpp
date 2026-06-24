#pragma once

#include "JsUtils.hpp"
#include <string>

namespace qvac_lib_inference_addon_cpp {
struct FinetuningParameters
{
  FinetuningParameters(js_env_t* env, js::Object finetuningParametersObj) :
    outputParametersDir(finetuningParametersObj.getProperty<js::String>(env, "outputParametersDir").as<std::string>(env)),
    numberOfEpochs(finetuningParametersObj.getProperty<js::Uint32>(env, "numberOfEpochs").as<uint32_t>(env)),
    learningRate(finetuningParametersObj.getProperty<js::Number>(env, "learningRate").as<double>(env)),
    trainDatasetDir(finetuningParametersObj.getProperty<js::String>(env, "trainDatasetDir").as<std::string>(env)),
    evalDatasetDir(finetuningParametersObj.getProperty<js::String>(env, "evalDatasetDir").as<std::string>(env))
  {

  }
  FinetuningParameters() = default;
  
  std::string outputParametersDir;
  int numberOfEpochs{0};
  double learningRate{0.0};
  std::string trainDatasetDir;
  std::string evalDatasetDir;
};

}
