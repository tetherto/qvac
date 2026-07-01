#pragma once

#include <any>
#include <memory>
#include <streambuf>
#include <string>

#include "RuntimeStats.hpp"
#include "job/JobId.hpp"

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

/// Marks a model that can process several jobs at once, as required by a
/// multi-job scheduler. process() may be called concurrently with distinct ids
/// and so must be safe to run in parallel. The @p id tags this call so the
/// model can map it for per-job cancellation (see IModelCancelById); streamed
/// output is tagged by the callback baked into @p input and the final result by
/// the scheduler. How many calls run at once is the scheduler's concern, not
/// something the model advertises.
struct IModelMultiprocessor {
  virtual ~IModelMultiprocessor() = default;
  IModelMultiprocessor() = default;
  IModelMultiprocessor(const IModelMultiprocessor&) = delete;
  IModelMultiprocessor& operator=(const IModelMultiprocessor&) = delete;

  virtual std::any process(const std::any& input, JobId id) = 0;
};

/// Per-job cancellation: cancel just the in-flight call admitted under @p id.
/// A no-op when the id is unknown (already finished, or never admitted).
struct IModelCancelById {
  virtual ~IModelCancelById() = default;
  IModelCancelById() = default;
  IModelCancelById(const IModelCancelById&) = delete;
  IModelCancelById& operator=(const IModelCancelById&) = delete;

  virtual void cancelById(JobId id) const = 0;
};

} // namespace qvac_lib_inference_addon_cpp::model
