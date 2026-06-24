#pragma once

#include <any>
#include <memory>
#include <streambuf>
#include <string>

#include "RuntimeStats.hpp"

namespace qvac_lib_inference_addon_cpp::model {

struct IModel {
  virtual ~IModel() = default;
  IModel() = default;
  IModel(const IModel&) = delete;
  IModel& operator=(const IModel&) = delete;
  [[nodiscard]] virtual std::string getName() const = 0;
  virtual std::any process(const std::any& input) = 0;
  [[nodiscard]] virtual RuntimeStats runtimeStats() const = 0;
};

// Optional interfaces below. Not every model will implement all of them.

struct IModelAsyncLoad {
  virtual ~IModelAsyncLoad() = default;
  IModelAsyncLoad() = default;
  IModelAsyncLoad(const IModelAsyncLoad&) = delete;
  IModelAsyncLoad& operator=(const IModelAsyncLoad&) = delete;
  virtual void waitForLoadInitialization() = 0;
  virtual void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& streambuf) = 0;
};

struct IModelCancel {
  virtual ~IModelCancel() = default;
  IModelCancel() = default;
  IModelCancel(const IModelCancel&) = delete;
  IModelCancel& operator=(const IModelCancel&) = delete;
  virtual void cancel() const = 0;
};

} // namespace qvac_lib_inference_addon_cpp::model
