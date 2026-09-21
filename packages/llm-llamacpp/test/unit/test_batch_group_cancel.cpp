// Per-group cancellation of tagged batch runs: cancelById(groupId) must tear
// down every scheduler slot the group holds — and nothing else. Peers (other
// groups, concurrent single jobs) keep running. This is the engine half of
// the JS "batch response cancel" contract (see batch-cancel-per-group.test.js).

#include <any>
#include <atomic>
#include <chrono>
#include <future>
#include <string>
#include <thread>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"

namespace {

using qvac_lib_inference_addon_cpp::JobId;

/// How long a cancel of a fully-queued job may take to settle. With the
/// targeted queued-cancel path this costs roughly one decode step — a lock, a
/// flag and a notify — so seconds are a very loose ceiling even on slow CI.
/// Without it the settle can only happen once a foreign job releases a slot,
/// which means a whole 256-token generation. Sized to sit far below that and
/// far above the fixed path's real cost.
constexpr auto kQueuedCancelSettleBudget = std::chrono::seconds(3);

class BatchGroupCancelTest : public ::testing::Test {
protected:
  void SetUp() override {
    using MP = test_common::TestModelPath;
    config_["device"] = test_common::getTestDevice();
    // Per-seq KV share = ctx_size / parallel = 512: essay prompts +
    // n_predict fit, and 256-token generations leave a wide window for the
    // cancel to land mid-run.
    config_["ctx_size"] = "2048";
    config_["gpu_layers"] = test_common::getTestGpuLayers();
    config_["parallel"] = "4";
    config_["batch_size"] = "256";
    config_["n_predict"] = "256";
    config_["temp"] = "0";
    config_["backendsDir"] = test_common::getTestBackendsDir().string();

    model_ =
        MP("Llama-3.2-1B-Instruct-Q4_0.gguf",
           nullptr,
           MP::OnMissing::Skip,
           "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF");
  }

  std::unique_ptr<LlamaModel> loadModel() {
    std::string path = model_.path;
    std::string projection;
    auto cfg = config_;
    auto model = std::make_unique<LlamaModel>(
        std::move(path), std::move(projection), std::move(cfg));
    model->waitForLoadInitialization();
    return model;
  }

  static LlamaModel::Prompt makePrompt(const std::string& userText) {
    LlamaModel::Prompt prompt;
    prompt.input = R"([{"role":"user","content":")" + userText + R"("}])";
    return prompt;
  }

  std::unordered_map<std::string, std::string> config_;
  test_common::TestModelPath model_;
};

} // namespace

/// A tagged batch group and a tagged single job run together; cancelById on
/// the GROUP id must cut both of the group's generations short while the
/// single job runs to completion. Guards the exact review finding: a running
/// batch group had no cancel action armed, so a per-group cancel evaporated
/// (and the JS fallback — whole-model cancel — killed the innocent peer).
TEST_F(BatchGroupCancelTest, CancelByIdCancelsOnlyTargetedGroup) {
  REQUIRE_MODEL(model_);
  auto model = loadModel();

  constexpr JobId kGroupId = 81;
  constexpr JobId kKeepId = 82;

  std::atomic<bool> groupTokenSeen = false;
  std::atomic<size_t> keepPieces = 0;

  std::vector<LlamaModel::Prompt> group;
  group.push_back(makePrompt(
      "Write a long, detailed, multi-paragraph essay about the history of "
      "astronomy."));
  group.push_back(makePrompt(
      "Write a long, detailed, multi-paragraph essay about the history of "
      "cartography."));
  for (auto& prompt : group) {
    prompt.outputCallback = [&groupTokenSeen](const std::string&) {
      groupTokenSeen.store(true);
    };
  }

  auto keepPrompt = makePrompt(
      "Write a long, detailed, multi-paragraph essay about ocean currents.");
  keepPrompt.outputCallback = [&keepPieces](const std::string&) {
    keepPieces.fetch_add(1);
  };

  auto groupFuture = std::async(std::launch::async, [&model, &group] {
    std::any out = model->process(std::any(group), kGroupId);
    return std::any_cast<std::vector<std::string>>(out);
  });
  auto keepFuture = std::async(std::launch::async, [&model, &keepPrompt] {
    std::any out = model->process(std::any(keepPrompt), kKeepId);
    return std::any_cast<std::string>(out);
  });

  // Cancel as soon as the group starts streaming, from this thread — never
  // from inside outputCallback (scheduler worker holds its mutex there).
  const auto tokenDeadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(120);
  while (!groupTokenSeen.load() &&
         std::chrono::steady_clock::now() < tokenDeadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_TRUE(groupTokenSeen.load())
      << "test setup: group never emitted a token";
  model->cancelById(kGroupId);

  ASSERT_EQ(
      groupFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready);
  ASSERT_EQ(
      keepFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready);
  const std::vector<std::string> cancelled = groupFuture.get();
  const std::string kept = keepFuture.get();

  ASSERT_EQ(cancelled.size(), 2u);
  EXPECT_FALSE(kept.empty()) << "untargeted single job must run to completion";
  EXPECT_GT(keepPieces.load(), 1u)
      << "untargeted single job produced no real generation";
  // The kept job, capped at 256 tokens on a long-form prompt, emits many
  // pieces; the group's slots are cut within a few tokens of the group's
  // first, so each member must be strictly shorter. The cancel hit every
  // slot of its own group and no other.
  for (size_t i = 0; i < cancelled.size(); i++) {
    EXPECT_LT(cancelled[i].size(), kept.size())
        << "group member " << i
        << " ran to completion; cancelById(groupId) did not land on its "
           "slot. output='"
        << cancelled[i] << "'";
  }
}

/// Cancelling a batch group while some of its prompts still wait behind the
/// parallel limit must reject the batch with `Cancelled` (README: cancelling
/// a batch): those prompts never ran, so completing the batch as a success
/// with empty outputs disguises the cancellation. Targeted counterpart of
/// CancelAllThrowsForUnrunPendingPrompts — here the group's pending requests
/// survive the cancel in the scheduler's queue, get admitted afterwards, are
/// refused at admission (the group is marked cancelled), and that refusal
/// must settle the group as Cancelled instead of quietly completing it.
TEST_F(BatchGroupCancelTest, CancelWithQueuedOverflowRejectsCancelled) {
  REQUIRE_MODEL(model_);
  // Batch of 4 on parallel=2: two prompts hold slots, two sit in pending_.
  config_["parallel"] = "2";
  auto model = loadModel();

  constexpr JobId kGroupId = 91;
  std::atomic<bool> groupTokenSeen = false;

  std::vector<LlamaModel::Prompt> group;
  for (int i = 0; i < 4; ++i) {
    auto prompt = makePrompt(
        "Write a long, detailed, multi-paragraph essay about the history of "
        "astronomy.");
    prompt.outputCallback = [&groupTokenSeen](const std::string&) {
      groupTokenSeen.store(true);
    };
    group.push_back(std::move(prompt));
  }

  auto future = std::async(std::launch::async, [&model, &group] {
    return model->process(std::any(group), kGroupId);
  });

  // Cancel from this thread as soon as a slot streams; the 256-token essay
  // generations hold both slots far longer, so the two overflow prompts are
  // still queued when the cancel lands.
  const auto tokenDeadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(120);
  while (!groupTokenSeen.load() &&
         std::chrono::steady_clock::now() < tokenDeadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_TRUE(groupTokenSeen.load())
      << "test setup: group never emitted a token";

  // Admission capacity is measured in slots, not jobs: this ONE batch job of 4
  // prompts occupies both slots and queues the other two, so occupancy is 4
  // while the scheduler's job count is 1. Gating `rejectWhenBusy` on the job
  // count is what let a fail-fast caller be admitted into a full pool.
  EXPECT_EQ(model->activeSlots(), 4u)
      << "a 4-prompt batch on parallel=2 must report 4 occupied-or-queued "
         "slots, not the 1 job it is";

  model->cancelById(kGroupId);

  ASSERT_EQ(
      future.wait_for(std::chrono::seconds(120)), std::future_status::ready);
  try {
    const std::any out = future.get();
    const auto outputs = std::any_cast<std::vector<std::string>>(out);
    FAIL() << "batch with queued prompts completed as a success after a "
              "targeted cancel; expected a Cancelled rejection (outputs="
           << outputs.size() << ")";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(e.codeString().find("Cancelled"), std::string::npos)
        << "expected a Cancelled error code, got: " << e.codeString();
  }

  // Everything the group held is released once it settles.
  EXPECT_EQ(model->activeSlots(), 0u)
      << "slots must drain after the cancelled group settles";
}

/// Cancelling a group whose requests are ALL still queued — behind a *foreign*
/// group holding the whole pool — must settle it immediately, not when that
/// unrelated group finally frees a slot.
///
/// CancelWithQueuedOverflowRejectsCancelled above cannot catch this: there the
/// cancelled group owns the slots itself, so tearing them down admits its own
/// overflow at once. With a foreign group holding the pool there is nothing to
/// tear down, the parked cancel is consumed only at a much later admission, and
/// `cancelJobs` blocks on the job's departure for that whole time — so
/// `response.cancel()` hangs for the length of someone else's generation.
///
/// The bound is what makes this a regression test. A purely relative "B before
/// A" check is NOT enough: A's slots do not finish together, so the first one
/// to free admits (and refuses) B's queued request before A's group as a whole
/// completes — that passes even with the fix reverted. B must instead settle
/// within a budget far shorter than any single generation: with the fix it
/// takes about one decode step (a lock, a flag, a notify), while waiting on a
/// freed slot costs a full 256-token generation. The margin between the two is
/// orders of magnitude, so the budget is generous without being permissive.
TEST_F(
    BatchGroupCancelTest, CancelOfFullyQueuedGroupDoesNotWaitForForeignWork) {
  REQUIRE_MODEL(model_);
  // parallel=2: group A's two prompts take both slots, so both of group B's sit
  // in pending_ with no slot of their own to cancel.
  config_["parallel"] = "2";
  auto model = loadModel();

  constexpr JobId kHolderId = 101;
  constexpr JobId kQueuedId = 102;
  std::atomic<bool> holderTokenSeen = false;

  std::vector<LlamaModel::Prompt> holder;
  for (int i = 0; i < 2; ++i) {
    auto prompt = makePrompt(
        "Write a long, detailed, multi-paragraph essay about the history of "
        "astronomy.");
    prompt.outputCallback = [&holderTokenSeen](const std::string&) {
      holderTokenSeen.store(true);
    };
    holder.push_back(std::move(prompt));
  }

  std::vector<LlamaModel::Prompt> queued;
  for (int i = 0; i < 2; ++i) {
    queued.push_back(makePrompt(
        "Write a long, detailed, multi-paragraph essay about ocean currents."));
  }

  auto holderFuture = std::async(std::launch::async, [&model, &holder] {
    return model->process(std::any(holder), kHolderId);
  });
  // Only submitted once A owns both slots, so B cannot win one.
  const auto tokenDeadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(120);
  while (!holderTokenSeen.load() &&
         std::chrono::steady_clock::now() < tokenDeadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_TRUE(holderTokenSeen.load())
      << "test setup: holder group never emitted a token";

  auto queuedFuture = std::async(std::launch::async, [&model, &queued] {
    return model->process(std::any(queued), kQueuedId);
  });
  // Let the queued group reach pending_ before cancelling it.
  std::this_thread::sleep_for(std::chrono::milliseconds(250));

  const auto cancelAt = std::chrono::steady_clock::now();
  model->cancelById(kQueuedId);

  ASSERT_EQ(
      queuedFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready)
      << "cancelled queued group never settled";
  const auto queuedSettledAfter = std::chrono::steady_clock::now() - cancelAt;

  EXPECT_LT(queuedSettledAfter, kQueuedCancelSettleBudget)
      << "the cancelled queued group took "
      << std::chrono::duration_cast<std::chrono::milliseconds>(
             queuedSettledAfter)
             .count()
      << "ms to settle: it waited for a slot the holder group had to release, "
         "i.e. on foreign work";

  ASSERT_EQ(
      holderFuture.wait_for(std::chrono::seconds(180)),
      std::future_status::ready);
  const auto holderFinishedAfter = std::chrono::steady_clock::now() - cancelAt;
  EXPECT_LT(queuedSettledAfter, holderFinishedAfter)
      << "the cancelled group outlived the holder it was queued behind";

  // Never ran, so it is an explicit Cancelled — same terminal as a whole-model
  // cancel draining pending_, and what the README documents.
  try {
    const std::any out = queuedFuture.get();
    const auto outputs = std::any_cast<std::vector<std::string>>(out);
    FAIL() << "queued group completed as a success after a targeted cancel "
              "(outputs="
           << outputs.size() << ")";
  } catch (const qvac_errors::StatusError& e) {
    EXPECT_NE(e.codeString().find("Cancelled"), std::string::npos)
        << "expected a Cancelled error code, got: " << e.codeString();
  }

  // The holder is untouched: a targeted cancel must not disturb a peer.
  const std::any holderOut = holderFuture.get();
  const auto holderOutputs = std::any_cast<std::vector<std::string>>(holderOut);
  ASSERT_EQ(holderOutputs.size(), 2u);
  for (size_t i = 0; i < holderOutputs.size(); i++) {
    EXPECT_FALSE(holderOutputs[i].empty())
        << "holder member " << i << " lost its output to a peer's cancel";
  }
}

/// The same hazard for a single tagged prompt queued behind a wider group: its
/// cancel must not wait for that group either. Covers the `processConcurrent`
/// path, which — unlike the batch path — had no pre-admission cancel handling
/// at all.
TEST_F(BatchGroupCancelTest, CancelOfQueuedSinglePromptSettlesImmediately) {
  REQUIRE_MODEL(model_);
  config_["parallel"] = "2";
  auto model = loadModel();

  constexpr JobId kHolderId = 111;
  constexpr JobId kQueuedId = 112;
  std::atomic<bool> holderTokenSeen = false;

  std::vector<LlamaModel::Prompt> holder;
  for (int i = 0; i < 2; ++i) {
    auto prompt = makePrompt(
        "Write a long, detailed, multi-paragraph essay about the history of "
        "cartography.");
    prompt.outputCallback = [&holderTokenSeen](const std::string&) {
      holderTokenSeen.store(true);
    };
    holder.push_back(std::move(prompt));
  }

  auto holderFuture = std::async(std::launch::async, [&model, &holder] {
    return model->process(std::any(holder), kHolderId);
  });
  const auto tokenDeadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(120);
  while (!holderTokenSeen.load() &&
         std::chrono::steady_clock::now() < tokenDeadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_TRUE(holderTokenSeen.load())
      << "test setup: holder group never emitted a token";

  auto queuedPrompt = makePrompt(
      "Write a long, detailed, multi-paragraph essay about ocean currents.");
  auto queuedFuture = std::async(std::launch::async, [&model, &queuedPrompt] {
    return model->process(std::any(queuedPrompt), kQueuedId);
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(250));

  const auto cancelAt = std::chrono::steady_clock::now();
  model->cancelById(kQueuedId);

  ASSERT_EQ(
      queuedFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready)
      << "cancelled queued single prompt never settled";
  const auto queuedSettledAfter = std::chrono::steady_clock::now() - cancelAt;

  EXPECT_LT(queuedSettledAfter, kQueuedCancelSettleBudget)
      << "the cancelled queued prompt took "
      << std::chrono::duration_cast<std::chrono::milliseconds>(
             queuedSettledAfter)
             .count()
      << "ms to settle: its cancel waited on foreign work";

  ASSERT_EQ(
      holderFuture.wait_for(std::chrono::seconds(180)),
      std::future_status::ready);
  const auto holderFinishedAfter = std::chrono::steady_clock::now() - cancelAt;
  EXPECT_LT(queuedSettledAfter, holderFinishedAfter)
      << "the cancelled prompt outlived the holder it was queued behind";

  // Settling early must NOT change the terminal a lone request reports. The
  // single-job contract is a graceful empty-output cancel (see submitLocked's
  // refusal path and CancelByIdBeforeFirstTokenCancelsJob): a caller cannot
  // tell a cancel that landed while the request was queued from one that landed
  // during prefill, and the latter must not throw. Only a multi-prompt group
  // rejects with Cancelled, because some of its prompts never ran.
  std::any queuedOut;
  ASSERT_NO_THROW(queuedOut = queuedFuture.get())
      << "a cancelled queued single prompt must resolve, not throw";
  EXPECT_TRUE(std::any_cast<std::string>(queuedOut).empty())
      << "a prompt cancelled before it ran must come back empty";
  EXPECT_NO_THROW(holderFuture.get());
}

/// The queued-group cancel must survive being issued from the scheduler's own
/// worker thread, where a streaming callback runs with the scheduler mutex
/// held: taking that mutex would self-deadlock, so the cancel has to be
/// recorded and applied at the worker's next reconciliation (the same
/// contract cancel(seqId, admissionId) already honours).
TEST_F(
    BatchGroupCancelTest, CancelOfQueuedGroupFromWorkerThreadDoesNotDeadlock) {
  REQUIRE_MODEL(model_);
  config_["parallel"] = "2";
  auto model = loadModel();

  constexpr JobId kHolderId = 121;
  constexpr JobId kQueuedId = 122;
  std::atomic<bool> holderTokenSeen = false;
  // Set once the queued group has been submitted, so the holder's callback
  // only fires the cancel when there is actually a queued group to hit.
  std::atomic<bool> queuedSubmitted = false;
  std::atomic<bool> workerCancelIssued = false;
  std::atomic<bool> workerCancelReturned = false;

  std::vector<LlamaModel::Prompt> holder;
  for (int i = 0; i < 2; ++i) {
    auto prompt = makePrompt(
        "Write a long, detailed, multi-paragraph essay about the history of "
        "astronomy.");
    // Runs on the scheduler's worker thread WITH its mutex held — the exact
    // reentrancy the deferred-apply path exists for. A cancelGroupQueued that
    // took the scheduler mutex here would self-deadlock and this test would
    // hang rather than fail.
    prompt.outputCallback = [&](const std::string&) {
      holderTokenSeen.store(true);
      if (!queuedSubmitted.load() || workerCancelIssued.exchange(true)) {
        return;
      }
      model->cancelById(kQueuedId);
      workerCancelReturned.store(true);
    };
    holder.push_back(std::move(prompt));
  }

  auto holderFuture = std::async(std::launch::async, [&model, &holder] {
    return model->process(std::any(holder), kHolderId);
  });
  const auto tokenDeadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(120);
  while (!holderTokenSeen.load() &&
         std::chrono::steady_clock::now() < tokenDeadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  ASSERT_TRUE(holderTokenSeen.load())
      << "test setup: holder group never emitted a token";

  std::vector<LlamaModel::Prompt> queued;
  for (int i = 0; i < 2; ++i) {
    queued.push_back(makePrompt(
        "Write a long, detailed, multi-paragraph essay about ocean currents."));
  }
  auto queuedFuture = std::async(std::launch::async, [&model, &queued] {
    return model->process(std::any(queued), kQueuedId);
  });
  // Let it reach pending_, then arm the worker-thread cancel.
  std::this_thread::sleep_for(std::chrono::milliseconds(250));
  queuedSubmitted.store(true);

  ASSERT_EQ(
      queuedFuture.wait_for(std::chrono::seconds(120)),
      std::future_status::ready)
      << "queued group never settled after a worker-thread cancel (deadlock?)";
  ASSERT_EQ(
      holderFuture.wait_for(std::chrono::seconds(180)),
      std::future_status::ready)
      << "holder never finished after a worker-thread cancel (deadlock?)";

  EXPECT_TRUE(workerCancelReturned.load())
      << "the worker-thread cancel never returned from cancelById";
  EXPECT_THROW(queuedFuture.get(), qvac_errors::StatusError);
  EXPECT_NO_THROW(holderFuture.get());
}
