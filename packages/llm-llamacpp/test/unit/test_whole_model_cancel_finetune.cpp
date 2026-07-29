#include <string>
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
// is wired (it always is, see AddonJs.hpp), which lands in cancelImpl(). A
// running finetune increments neither run counter, so both engine-stop
// branches no-op, and its registry entry armed at tagged dispatch means
// parkAll() only sets a cancelRequested flag that nothing ever consumes
// again. The finetune therefore keeps training and the destructor joins its
// worker for the full remaining training duration.
//
// The contract pinned here: every whole-model cancel must forward an
// explicit finetune cancellation request (the same pause-without-checkpoint
// the armed per-id action issues). The forward is unconditional — it must
// not be gated on state_ or the run counters, because a finetune holds
// neither — so it is observable on an unloaded model; the finetuner side
// no-ops when no finetune is running. Asserted as a delta on purpose:
// construction itself already issues a whole-model cancel (setInitLoader
// cancels any prior work), so the counter need not start at zero — what
// matters is that THIS cancel adds a forward.
TEST(
    WholeModelCancelFinetuneTest,
    WholeModelCancelForwardsFinetuneCancellation) {
  LlamaModel model = makeUnloadedModel();
  const unsigned before = LlamaModelTestPeer::finetuneCancelRequests(model);

  model.cancel();

  EXPECT_GE(LlamaModelTestPeer::finetuneCancelRequests(model), before + 1U)
      << "whole-model cancel never reached the finetuner: both run-counter "
         "branches no-op for a finetune and parkAll() only parks a flag on "
         "its already-armed registry entry, so a running finetune trains to "
         "completion and native teardown blocks on the worker join for the "
         "remaining training duration";
}
