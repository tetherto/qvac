#pragma once

#include <any>
#include <functional>
#include <future>
#include <memory>
#include <utility>

#include "../job/JobId.hpp"
#include "OutputQueue.hpp"

namespace qvac_lib_inference_addon_cpp {

/// Factories for the typed callbacks a model prompt stores to stream results
/// into the addon's OutputQueue. They take the queue's shared_ptr on purpose:
/// the returned callback runs on scheduler workers that async cancel/pause
/// can keep alive past destroyInstance(), so it must co-own the queue instead
/// of reaching it through an AddonJs/AddonCpp reference that may already be
/// gone. ~AddonCpp joins all workers before the queue's notify target dies,
/// so a live worker always finds a live queue.
template <typename T>
std::function<void(const T&)>
makeQueueCallback(std::shared_ptr<OutputQueue> queue, JobId id = kNoJobId) {
  return [queue = std::move(queue), id](const T& value) {
    queue->queueResult(std::any(value), id);
  };
}

/// Tags entries with a job id that is only known after admission: the
/// scheduler mints the id and admission returns it, but the callback must be
/// built first. The future is fulfilled right after admission on the JS
/// thread; a worker that races ahead blocks on get() for at most that
/// hand-off.
template <typename T>
std::function<void(const T&)> makeQueueCallback(
    std::shared_ptr<OutputQueue> queue, std::shared_future<JobId> idFuture) {
  return [queue = std::move(queue),
          idFuture = std::move(idFuture)](const T& value) {
    queue->queueResult(std::any(value), idFuture.get());
  };
}

} // namespace qvac_lib_inference_addon_cpp
