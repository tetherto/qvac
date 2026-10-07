// Opt-in KV-cache suite: conversations kept between requests (parked slots,
// the RAM tier, cacheKey files) across failures, rollbacks, evictions and
// unloads. Every test skips unless QVAC_RUN_KV_CACHE_EXTENDED=1, then skips
// again when its model is absent (`npm run test:cpp:models`).
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#ifndef _WIN32
#include <unistd.h>
#endif

#include "model-interface/ContinuousBatchScheduler.hpp"
#include "model-interface/LlamaModel.hpp"
#include "model-interface/SlotStateCache.hpp"
#include "model-interface/TextLlmContext.hpp"
#include "test_common.hpp"
#include "test_internal_peers.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ReasoningUtils.hpp"
#include "utils/SequenceStateSnapshot.hpp"

namespace fs = std::filesystem;
using qvac_lib_inference_addon_llama::batching::ContinuousBatchScheduler;
using qvac_lib_inference_addon_llama::batching::SlotStateCache;
using qvac_lib_inference_addon_llama::batching::SlotStateCacheEntry;

namespace {

constexpr const char* WEATHER_TOOL =
    R"({"type":"function","name":"get_weather","description":"Get the weather for a city",)"
    R"("parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}})";

// Never completes, so a request under it runs until its slot's window fills.
constexpr const char* ENDLESS_GRAMMAR = R"(root ::= "lighthouse " root)";

using Chat = std::vector<std::pair<std::string, std::string>>;

std::string chatInput(const Chat& messages, const char* tool = nullptr) {
  nlohmann::json array = nlohmann::json::array();
  for (const auto& [role, content] : messages) {
    array.push_back({{"role", role}, {"content", content}});
  }
  if (tool != nullptr) {
    array.push_back(nlohmann::json::parse(tool));
  }
  return array.dump();
}

test_common::TestModelPath qwen3Model() {
  return test_common::TestModelPath(
      "Qwen3-0.6B-Q8_0.gguf",
      "QWEN3_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF");
}

test_common::TestModelPath qwen35Model() {
  return test_common::TestModelPath(
      "Qwen3.5-0.8B-Q8_0.gguf",
      "QWEN35_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Skip,
      "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF");
}

std::unique_ptr<LlamaModel> loadModel(
    const test_common::TestModelPath& modelPath,
    std::unordered_map<std::string, std::string> overrides = {}) {
  std::unordered_map<std::string, std::string> config;
  config["device"] = test_common::getTestDevice();
  config["gpu_layers"] = test_common::getTestGpuLayers();
  config["ctx_size"] = "4096";
  config["n_predict"] = "24";
  config["temp"] = "0";
  config["seed"] = "7";
  config["tools"] = "true";
  config["backendsDir"] = test_common::getTestBackendsDir().string();
  for (auto& [key, value] : overrides) {
    config[key] = std::move(value);
  }
  std::string path = modelPath.path;
  auto model = std::make_unique<LlamaModel>(
      std::move(path), std::string(), std::move(config));
  model->waitForLoadInitialization();
  if (!model->isLoaded()) {
    throw std::runtime_error("test model failed to load");
  }
  return model;
}

LlamaModel::Prompt keyed(
    const std::string& input, const std::string& cacheKey,
    bool ephemeral = false) {
  LlamaModel::Prompt prompt;
  prompt.input = input;
  prompt.cacheKey = cacheKey;
  prompt.ephemeral = ephemeral;
  prompt.generationParams.reasoning_budget = 0;
  return prompt;
}

std::string runBatch(LlamaModel& model, const LlamaModel::Prompt& prompt) {
  return model.processPromptBatch({prompt}).at(0);
}

ContinuousBatchScheduler& schedulerOf(LlamaModel& model) {
  auto* scheduler = LlamaModelTestPeer::scheduler(model);
  if (scheduler == nullptr) {
    throw std::runtime_error("the model has no batch scheduler");
  }
  return *scheduler;
}

std::vector<char> readBytes(const fs::path& path) {
  std::ifstream stream(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(stream), {}};
}

/// A fresh directory for one test's cache files, removed when it goes.
class ScratchDir {
public:
  explicit ScratchDir(const std::string& name)
      : path_(fs::temp_directory_path() / ("qvac_kv_ext_" + name)) {
    std::error_code ec;
    fs::permissions(path_, fs::perms::owner_all, ec);
    fs::remove_all(path_, ec);
    fs::create_directories(path_);
  }
  ~ScratchDir() {
    std::error_code ec;
    fs::permissions(path_, fs::perms::owner_all, ec);
    fs::remove_all(path_, ec);
  }
  ScratchDir(const ScratchDir&) = delete;
  ScratchDir& operator=(const ScratchDir&) = delete;

  [[nodiscard]] std::string file(const std::string& name) const {
    return (path_ / name).string();
  }
  [[nodiscard]] const fs::path& path() const { return path_; }

private:
  fs::path path_;
};

/// Raises the log level to WARNING and captures stdout, where the standalone
/// test build sends QLOG output.
class WarningCapture {
public:
  WarningCapture()
      : saved_(qvac_lib_inference_addon_llama::logging::g_verbosityLevel) {
    qvac_lib_inference_addon_llama::logging::g_verbosityLevel =
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING;
    testing::internal::CaptureStdout();
  }
  ~WarningCapture() {
    if (!taken_) {
      (void)testing::internal::GetCapturedStdout();
    }
    qvac_lib_inference_addon_llama::logging::g_verbosityLevel = saved_;
  }
  WarningCapture(const WarningCapture&) = delete;
  WarningCapture& operator=(const WarningCapture&) = delete;

  std::string take() {
    taken_ = true;
    return testing::internal::GetCapturedStdout();
  }

private:
  qvac_lib_inference_addon_cpp::logger::Priority saved_;
  bool taken_ = false;
};

const Chat FIRST_TURN = {
    {"system", "You are a concise assistant."},
    {"user", "Name one colour of the rainbow."}};

Chat followUp(const std::string& answer, const std::string& question) {
  Chat chat = FIRST_TURN;
  chat.emplace_back("assistant", answer);
  chat.emplace_back("user", question);
  return chat;
}

/// A request that throws while its prompt is rendered, before the driver
/// begins its cache request: the batch path validates `tool_choice` there.
LlamaModel::Prompt
failingInRender(const std::string& answer, const std::string& cacheKey) {
  LlamaModel::Prompt prompt = keyed(
      chatInput(followUp(answer, "And another?"), WEATHER_TOOL), cacheKey);
  prompt.generationParams.tool_choice = "notDeclared";
  return prompt;
}

void admissionThrowKeepsAdoptedState(const test_common::TestModelPath& path) {
  ScratchDir dir("admission_throw");
  const std::string key = dir.file("chat.bin");

  auto model = loadModel(path, {{"parallel", "2"}});
  auto& scheduler = schedulerOf(*model);
  const std::string answer =
      runBatch(*model, keyed(chatInput(FIRST_TURN), key));
  ASSERT_FALSE(fs::exists(key)) << "the first turn must stay in memory";

  EXPECT_THROW(
      (void)runBatch(*model, failingInRender(answer, key)),
      qvac_errors::StatusError);

  // The failed request never happened: the conversation is still kept, and
  // what gets written for it must load.
  ASSERT_NO_THROW(model->saveCache(key))
      << "the conversation was lost by a request that never started";
  ASSERT_TRUE(fs::exists(key));
  {
    auto fresh = loadModel(path, {{"parallel", "2"}});
    EXPECT_NO_THROW((void)runBatch(
        *fresh, keyed(chatInput(followUp(answer, "Name another.")), key)))
        << "the file written after a failed admission must load";
  }

  const uint64_t hitsBefore = scheduler.residentHitsForTesting();
  (void)runBatch(
      *model, keyed(chatInput(followUp(answer, "Name another.")), key));
  EXPECT_EQ(scheduler.residentHitsForTesting(), hitsBefore + 1)
      << "the next request must find the conversation still resident";
}

} // namespace

// C1: a request on a parked, unsaved conversation that throws before its cache
// request begins must leave that conversation as it was, on pure attention...
TEST(KvCacheExtended, AdmissionThrowOnAdoptedDirtyStateKeepsItLoadable) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
  const auto path = qwen3Model();
  REQUIRE_MODEL(path);
  admissionThrowKeepsAdoptedState(path);
}

// ...and on hybrid memory, which cannot trim and used to drop it instead.
TEST(KvCacheExtended, AdmissionThrowOnAdoptedDirtyStateKeepsItLoadableHybrid) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
  const auto path = qwen35Model();
  REQUIRE_MODEL(path);
  admissionThrowKeepsAdoptedState(path);
}

// C2: a request that rolls back (here: its generation fills the slot's window)
// lands back on the conversation it resumed, which must stay kept.
TEST(KvCacheExtended, RollbackOnAdoptedConversationKeepsItResident) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
  const auto path = qwen3Model();
  REQUIRE_MODEL(path);
  ScratchDir dir("rollback_resident");
  const std::string key = dir.file("chat.bin");

  // 384 positions per slot: the endless grammar overflows it quickly.
  auto model = loadModel(
      path, {{"parallel", "2"}, {"ctx_size", "768"}, {"tools", "false"}});
  auto& scheduler = schedulerOf(*model);
  const std::string answer =
      runBatch(*model, keyed(chatInput(FIRST_TURN), key));

  LlamaModel::Prompt overflowing =
      keyed(chatInput(followUp(answer, "Tell me a long story.")), key);
  overflowing.generationParams.grammar = ENDLESS_GRAMMAR;
  overflowing.generationParams.n_predict = -1;
  try {
    (void)runBatch(*model, overflowing);
  } catch (const qvac_errors::StatusError&) {
    // Overflow may surface as an error; what is kept afterwards is the point.
  }

  EXPECT_NO_THROW(model->saveCache(key))
      << "the conversation the overflowing turn resumed was dropped";
  const uint64_t hitsBefore = scheduler.residentHitsForTesting();
  (void)runBatch(
      *model, keyed(chatInput(followUp(answer, "Name another.")), key));
  EXPECT_EQ(scheduler.residentHitsForTesting(), hitsBefore + 1)
      << "a rolled-back turn must leave the resumed conversation resident";
}

// C3: discardCache drops a conversation that was never written, so nothing
// brings it back at unload.
TEST(KvCacheExtended, DiscardDropsANeverWrittenConversation) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
  const auto path = qwen3Model();
  REQUIRE_MODEL(path);
  ScratchDir dir("discard");
  const std::string batchKey = dir.file("batch.bin");
  const std::string singleKey = dir.file("single.bin");
  {
    auto batch = loadModel(path, {{"parallel", "2"}});
    (void)runBatch(*batch, keyed(chatInput(FIRST_TURN), batchKey));
    batch->discardCache(batchKey);
    EXPECT_THROW(batch->saveCache(batchKey), qvac_errors::StatusError)
        << "a discarded conversation must not be saveable";
  }
  EXPECT_FALSE(fs::exists(batchKey))
      << "unload wrote a conversation the caller discarded";
  {
    auto single = loadModel(path);
    (void)single->processPrompt(keyed(chatInput(FIRST_TURN), singleKey));
    single->discardCache(singleKey);
  }
  EXPECT_FALSE(fs::exists(singleKey))
      << "unload wrote a single-prompt conversation the caller discarded";
}

// C4: a key switch with a one-conversation RAM tier must hand back the
// incoming conversation, not evict it to make room for the outgoing one.
TEST(KvCacheExtended, KeySwitchKeepsIncomingInRamTier) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
  const auto path = qwen3Model();
  REQUIRE_MODEL(path);
  ScratchDir dir("ram_tier_switch");
  const auto prefill = [](const std::string& word, const std::string& key) {
    LlamaModel::Prompt prompt = keyed(
        chatInput({{"user", "Remember the word " + word + " for later."}}),
        key,
        /*ephemeral=*/true);
    prompt.prefill = true;
    return prompt;
  };
  const std::string keyA = dir.file("a.bin");
  const std::string keyB = dir.file("b.bin");
  const std::string keyC = dir.file("c.bin");

  // Size the tier from one conversation's real footprint.
  uint64_t entryBytes = 0;
  {
    auto probe = loadModel(path, {{"parallel", "2"}, {"cache_ram_mib", "512"}});
    (void)runBatch(*probe, prefill("apple", keyA));
    (void)runBatch(*probe, prefill("grape", keyB));
    (void)runBatch(*probe, prefill("lemon", keyC));
    entryBytes = LlamaModelTestPeer::ramTier(*probe)->totalBytes();
  }
  ASSERT_GT(entryBytes, 0u) << "the third key did not evict into the tier";
  const uint64_t budgetMib = ((entryBytes * 3) / 2) / (1024 * 1024) + 1;
  ASSERT_LT(budgetMib * 1024 * 1024, entryBytes * 2)
      << "two conversations would fit; the test cannot discriminate";

  auto model = loadModel(
      path, {{"parallel", "2"}, {"cache_ram_mib", std::to_string(budgetMib)}});
  auto& scheduler = schedulerOf(*model);
  (void)runBatch(*model, prefill("apple", keyA));
  (void)runBatch(*model, prefill("grape", keyB));
  (void)runBatch(*model, prefill("lemon", keyC)); // A moves to the tier
  const uint64_t ramHitsBefore = scheduler.ramTierHitsForTesting();
  (void)runBatch(*model, prefill("apple", keyA)); // B must not displace A
  EXPECT_EQ(scheduler.ramTierHitsForTesting(), ramHitsBefore + 1)
      << "the incoming conversation was evicted to make room for the outgoing";
  EXPECT_FALSE(fs::exists(keyA)) << "an ephemeral conversation was written";
}

// C5: a RAM-tier write that fails is reported and keeps the entry unsaved.
TEST(KvCacheExtended, TierWriteFailureIsLoggedAndEntryStaysDirty) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
#ifdef _WIN32
  GTEST_SKIP() << "relies on POSIX directory permissions";
#else
  if (::geteuid() == 0) {
    GTEST_SKIP() << "root ignores directory permissions";
  }
#endif
  const auto path = qwen3Model();
  REQUIRE_MODEL(path);
  ScratchDir dir("tier_write_failure");
  const std::string key = dir.file("chat.bin");

  auto model = loadModel(path, {{"parallel", "2"}, {"cache_ram_mib", "512"}});
  auto& scheduler = schedulerOf(*model);
  (void)runBatch(*model, keyed(chatInput(FIRST_TURN), key));
  for (const uint32_t seqId : scheduler.parkedSeqIds()) {
    scheduler.evictParked(seqId);
  }
  SlotStateCache* tier = LlamaModelTestPeer::ramTier(*model);
  ASSERT_NE(tier, nullptr);
  ASSERT_EQ(tier->size(), 1u) << "the conversation did not reach the tier";

  fs::permissions(dir.path(), fs::perms::owner_read | fs::perms::owner_exec);
  std::string log;
  size_t written = 0;
  {
    WarningCapture capture;
    written = tier->flushDirty();
    log = capture.take();
  }
  fs::permissions(dir.path(), fs::perms::owner_all);

  EXPECT_EQ(written, 0u);
  EXPECT_FALSE(fs::exists(key));
  EXPECT_FALSE(fs::exists(key + ".tmp")) << "a failed write left its temp file";
  EXPECT_NE(log.find("WARNING"), std::string::npos)
      << "a failed write-back was not reported: " << log;
  EXPECT_NE(log.find(key), std::string::npos)
      << "the warning does not name the key: " << log;
  EXPECT_EQ(tier->flushDirty(), 1u)
      << "the entry was marked clean although its write failed";
}

// C6: one request failing inside a decode step must not take other keys'
// parked conversations with it.
TEST(KvCacheExtended, WorkerCatchAllPersistsParkedConversations) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
  const auto path = qwen3Model();
  REQUIRE_MODEL(path);
  ScratchDir dir("catch_all");
  const std::string keyA = dir.file("a.bin");
  const std::string keyB = dir.file("b.bin");

  auto model = loadModel(path, {{"parallel", "2"}});
  auto& scheduler = schedulerOf(*model);
  (void)runBatch(*model, keyed(chatInput(FIRST_TURN), keyA));
  ASSERT_FALSE(fs::exists(keyA));

  bool thrown = false;
  ContinuousBatchSchedulerTestPeer::setDecodeFunc(
      scheduler, [&thrown](llama_context* ctx, llama_batch& batch) {
        if (!thrown) {
          thrown = true;
          throw std::runtime_error("injected step failure");
        }
        return llama_decode(ctx, batch);
      });
  EXPECT_ANY_THROW(
      (void)runBatch(*model, keyed(chatInput({{"user", "Say hello."}}), keyB)));
  ASSERT_TRUE(thrown);

  EXPECT_TRUE(fs::exists(keyA))
      << "the failure dropped another key's unsaved conversation";
  EXPECT_NO_THROW((void)runBatch(
      *model, keyed(chatInput(followUp("Red.", "Name another.")), keyA)));
}

// C7: a RAM-tier entry whose ledger does not describe its state is dropped
// with a warning, never written over the file.
TEST(KvCacheExtended, RamTierRestoreFailureNeverWritesARejectedLedger) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
  const auto path = qwen3Model();
  REQUIRE_MODEL(path);
  ScratchDir dir("tier_rejected");
  const std::string key = dir.file("chat.bin");

  auto model = loadModel(path, {{"parallel", "2"}, {"cache_ram_mib", "512"}});
  auto& scheduler = schedulerOf(*model);
  const std::string answer =
      runBatch(*model, keyed(chatInput(FIRST_TURN), key));
  model->saveCache(key);
  const std::vector<char> saved = readBytes(key);
  ASSERT_FALSE(saved.empty());

  (void)runBatch(*model, keyed(chatInput(followUp(answer, "Another?")), key));
  for (const uint32_t seqId : scheduler.parkedSeqIds()) {
    scheduler.evictParked(seqId);
  }
  SlotStateCache* tier = LlamaModelTestPeer::ramTier(*model);
  std::optional<SlotStateCacheEntry> entry = tier->take(key);
  ASSERT_TRUE(entry.has_value()) << "the conversation did not reach the tier";
  ASSERT_TRUE(entry->dirty);
  // Keep the marker and header, drop the entries: a ledger that no longer
  // matches the state it travels with.
  entry->ledgerWords.resize(entry->ledgerWords.size() / 2);
  ASSERT_TRUE(tier->insert(key, std::move(*entry)));

  std::string log;
  {
    WarningCapture capture;
    EXPECT_NO_THROW((void)runBatch(*model, keyed(chatInput(FIRST_TURN), key)));
    log = capture.take();
  }
  EXPECT_EQ(readBytes(key), saved)
      << "a rejected ledger was written over the conversation's file";
  EXPECT_NE(log.find("unsaved turns are dropped"), std::string::npos)
      << "dropping a dirty RAM-tier entry was not reported: " << log;
}

// C8: the answer starts after the close tag the streaming parser stopped at.
TEST(KvCacheExtended, SplitReasoningKeepsTextAfterFirstClose) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
  using qvac_lib_inference_addon_llama::utils::ReasoningTags;
  using qvac_lib_inference_addon_llama::utils::splitReasoningFromContent;
  const ReasoningTags think{.open = "<think>", .close = "</think>"};

  const auto twoCloses =
      splitReasoningFromContent("<think>r</think>Use the </think> tag", think);
  ASSERT_TRUE(twoCloses.has_value());
  EXPECT_EQ(twoCloses->reasoning, "r");
  EXPECT_EQ(twoCloses->content, "Use the </think> tag");

  const auto oneClose =
      splitReasoningFromContent("<think>\nr\n</think>\n\nBlue.", think);
  ASSERT_TRUE(oneClose.has_value());
  EXPECT_EQ(oneClose->reasoning, "r");
  EXPECT_EQ(oneClose->content, "Blue.");
}

// C9: benchmark, reports rather than asserts timing. Every cached turn renders
// and tokenizes the whole history, so the per-turn cost grows with it.
TEST(KvCacheExtended, RenderCostPerTurn) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
  const auto path = qwen3Model();
  REQUIRE_MODEL(path);
  ScratchDir dir("render_cost");
  const std::string key = dir.file("chat.bin");
  auto model = loadModel(path, {{"ctx_size", "32768"}});
  auto* text =
      dynamic_cast<TextLlmContext*>(LlamaModelTestPeer::llmContext(*model));
  ASSERT_NE(text, nullptr);

  constexpr int TURNS = 120;
  Chat chat = {{"system", "You are a concise assistant."}};
  size_t previousReuse = 0;
  for (int turn = 1; turn <= TURNS; ++turn) {
    chat.emplace_back(
        "user",
        "Fact " + std::to_string(turn) +
            ": the harbour lamp was checked and found working.");
    LlamaModel::Prompt prompt = keyed(chatInput(chat), key);
    prompt.prefill = true;
    const auto start = std::chrono::steady_clock::now();
    (void)model->processPrompt(prompt);
    const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - start);
    if (turn > 1) {
      EXPECT_GT(text->lastCacheReuseForTesting(), previousReuse)
          << "turn " << turn << " did not reuse the history";
    }
    previousReuse = text->lastCacheReuseForTesting();
    if (turn == 1 || turn % 20 == 0) {
      std::cout << "[render-cost] turn=" << turn
                << " reused=" << text->lastCacheReuseForTesting()
                << " us=" << elapsed.count() << "\n";
    }
    chat.emplace_back("assistant", "Noted.");
  }
}

// C10: `cache_checkpoint_storage: disk` without a private snapshot directory
// fails the load, instead of writing to the shared temp dir or silently
// keeping snapshots in memory. The snapshot directory is process-wide and
// kept once created, so run this alone
// (`--gtest_filter=*DiskStorageWithoutPrivateDirFailsTheLoad*`).
TEST(KvCacheExtended, DiskStorageWithoutPrivateDirFailsTheLoad) {
  SKIP_UNLESS_KV_CACHE_EXTENDED();
#ifdef _WIN32
  GTEST_SKIP() << "relies on POSIX directory permissions";
#else
  if (::geteuid() == 0) {
    GTEST_SKIP() << "root ignores directory permissions";
  }
  namespace utils = qvac_lib_inference_addon_llama::utils;
  if (utils::sequenceStateSnapshotFilesWritten() > 0) {
    GTEST_SKIP() << "a disk snapshot already ran in this process; run alone";
  }
  const auto path = qwen35Model();
  REQUIRE_MODEL(path);

  ScratchDir readOnly("snapshot_tmp");
  fs::permissions(
      readOnly.path(), fs::perms::owner_read | fs::perms::owner_exec);
  const char* previous = std::getenv("TMPDIR");
  const std::string savedTmp = previous != nullptr ? previous : "";
  ::setenv("TMPDIR", readOnly.path().c_str(), 1);

  std::string error;
  try {
    (void)loadModel(path, {{"cache_checkpoint_storage", "disk"}});
  } catch (const std::exception& e) {
    error = e.what();
  }
  bool memoryLoaded = false;
  try {
    memoryLoaded =
        loadModel(path, {{"cache_checkpoint_storage", "memory"}})->isLoaded();
  } catch (const std::exception&) {
  }

  if (previous != nullptr) {
    ::setenv("TMPDIR", savedTmp.c_str(), 1);
  } else {
    ::unsetenv("TMPDIR");
  }
  fs::permissions(readOnly.path(), fs::perms::owner_all);

  EXPECT_NE(error.find("cache_checkpoint_storage 'disk'"), std::string::npos)
      << "the load did not fail with the storage error: " << error;
  EXPECT_NE(error.find(readOnly.path().string()), std::string::npos)
      << "the error does not name the temp dir: " << error;
  EXPECT_TRUE(fs::is_empty(readOnly.path()))
      << "something was written to the temp dir";
  EXPECT_EQ(utils::sequenceStateSnapshotFilesWritten(), 0u);
  EXPECT_TRUE(memoryLoaded) << "memory storage must not need the directory";
#endif
}
