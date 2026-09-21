#include <latch>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>

#include <gtest/gtest.h>

#include "test_internal_peers.hpp"

namespace {

LlamaModel makeUnloadedModel() {
  std::unordered_map<std::string, std::string> config;
  config["device"] = "cpu";
  return LlamaModel("nonexistent_model.gguf", "", std::move(config));
}

} // namespace

// Whole-model cancel is the only cancel signal native teardown issues: the
// multi-job scheduler destructor prefers IModelCancel::cancel() whenever it
// is wired. A running finetune owns neither inference run counter, so teardown
// must use its explicit lifecycle marker rather than an engine-stop branch.
//
// The contract pinned here: whole-model cancel must forward an explicit
// cancellation to the active finetune even though it owns neither inference
// run counter.
TEST(
    WholeModelCancelFinetuneTest,
    WholeModelCancelForwardsFinetuneCancellation) {
  LlamaModel model = makeUnloadedModel();
  constexpr qvac_lib_inference_addon_cpp::JobId finetuneId = 1;
  LlamaModelTestPeer::setActiveFinetuneJob(model, finetuneId);
  const unsigned before = LlamaModelTestPeer::finetuneCancelRequests(model);

  model.cancel();

  EXPECT_GE(LlamaModelTestPeer::finetuneCancelRequests(model), before + 1U)
      << "whole-model cancel never reached the finetuner: both run-counter "
         "branches no-op for a finetune and parkAll() only parks a flag on "
         "its already-armed registry entry, so a running finetune trains to "
         "completion and native teardown blocks on the worker join for the "
         "remaining training duration";
}

TEST(
    WholeModelCancelFinetuneTest, WholeModelCancelReachesFinetuneDuringReload) {
  LlamaModel model = makeUnloadedModel();
  constexpr qvac_lib_inference_addon_cpp::JobId finetuneId = 1;
  LlamaModelTestPeer::setActiveFinetuneJob(model, finetuneId);
  const unsigned before = LlamaModelTestPeer::finetuneCancelRequests(model);
  std::latch reloadLocked{1};
  std::latch releaseReload{1};
  std::thread reload([&] {
    std::unique_lock lock(LlamaModelTestPeer::stateMutex(model));
    reloadLocked.count_down();
    releaseReload.wait();
  });
  reloadLocked.wait();

  model.cancel();
  const unsigned after = LlamaModelTestPeer::finetuneCancelRequests(model);

  releaseReload.count_down();
  reload.join();
  EXPECT_GE(after, before + 1U)
      << "teardown cancellation was dropped while reload owned stateMtx_";
}
