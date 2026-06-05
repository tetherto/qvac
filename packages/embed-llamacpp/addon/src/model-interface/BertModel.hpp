#pragma once

#include <any>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include <llama/common/common.h>
#include <llama/common/log.h>

#include "AsyncWeightsLoader.hpp"
#include "LlamaLazyInitializeBackend.hpp"
#include "ModelMetadata.hpp"
#include "inference-addon-cpp/GGUFShards.hpp"
#include "inference-addon-cpp/InitLoader.hpp"
#include "inference-addon-cpp/ModelInterfaces.hpp"
#include "inference-addon-cpp/RuntimeStats.hpp"
#include "utils.hpp"

#ifdef _MSC_VER
#pragma warning(disable : 4244 4267) // possible loss of data
#endif

namespace qvac_lib_infer_llamacpp_embed {
// Sequences are passed directly as type: 'sequences' from JavaScript
// and converted to std::vector<std::string> in C++ append() handler
} // namespace qvac_lib_infer_llamacpp_embed

/// @brief This class eases access to multiple embedding vectors.
class BertEmbeddings {
private:
  std::vector<float> flat_embd_;
  std::size_t embeddingCount_ = 0;
  std::size_t embeddingSize_ = 0;

public:
  struct Layout {
    std::size_t embeddingCount;
    std::size_t embeddingSize;
  };

  explicit BertEmbeddings(std::vector<float> flatData, Layout layout);

  /// @brief Returns one of the embeddings.
  std::span<const float> operator[](std::size_t index) const;

  [[nodiscard]] std::size_t size() const;
  [[nodiscard]] std::size_t embeddingSize() const;
};

struct BertCommonInitResult {
  common_params params;
  common_init_result_ptr result;
};

/// @brief Bundle of parameters required to initialize a BertModel: the parsed
/// llama.cpp common_params, plus addon-specific flags resolved during setup
/// (whether the caller explicitly configured ctx_size, and which backend
/// device was selected).
struct BertModelSetup {
  common_params params;
  bool ctxSizeConfigured = false;
  int64_t resolvedBackendDevice = 0;
};

/// @brief Instantiates a BERT language model. An open source architecture
/// designed to help machines understand context in sentences and used for
/// natural language processing (NLP) and understanding (NLU).
///
/// @details There are many popular models based on the BERT architecture
/// where the weights and layer configuration can vary depending on the task
/// its being trained on. Initial models such as `bert-large-uncased` were
/// trained to help predict masked words on a sentence or the probability that
/// one sentence follows another. Other models such as `gte-large`, are
/// trained to generate general word embeddings that summarize text
/// information and that can be used, for example, to compare text's
/// similarity or to search for most meaningful entries on a vector database.
// NOLINTBEGIN(cppcoreguidelines-non-private-member-variables-in-classes,
// readability-avoid-const-params-in-decls)
class BertModel : public qvac_lib_inference_addon_cpp::model::IModel,
                  public qvac_lib_inference_addon_cpp::model::IModelAsyncLoad,
                  public qvac_lib_inference_addon_cpp::model::IModelCancel {
private:
  BertCommonInitResult init_;
  llama_model* model_;
  llama_context* ctx_;
  const llama_vocab* vocab_;
  mutable struct llama_batch batch_;
  bool is_loaded_;

  const std::string loadingContext_;
  GGUFShards shards_;
  friend class InitLoader;
  InitLoader initLoader_;
  std::optional<LlamaBackendsHandle> backendsHandle_;
  mutable std::atomic<bool> stopCancelled_{false};
  int64_t runtimeBackendDevice_ = 0;
  bool ctxSizeConfigured_ = false;
  ModelMetaData metadata_;
  AsyncWeightsLoader asyncWeightsLoader_;

public:
  // These using definitions are accessed by the Addon<BertModel> template.
  using OutputType = BertEmbeddings;
  using Input = std::variant<std::string, std::vector<std::string>>;
  using InputView = Input;
  using Output = OutputType;

  using TokenizerHandle = void*;

  /// @brief Resolves shard basenames in-place to absolute paths relative to
  /// the parent directory of @p modelPath. `GGUFShards::expandGGUFIntoShards`
  /// only populates basenames; resolving them is required for both pre-load
  /// metadata inspection and `llama_model_load_from_splits` when the working
  /// directory differs from the model directory.
  static void
  resolveShardPaths(GGUFShards& shards, const std::string& modelPath);

  /// @brief This constructor allows to specify model to load more clearly and
  /// override default common params by a configuration object.
  ///
  /// @param config: Configuration key/value map.
  BertModel(
      const std::string& modelGgufPath,
      const std::unordered_map<std::string, std::string>& config,
      const std::string& backendsDir = "");

  /// @brief Construct with already parsed parameters bundled in a
  /// @ref BertModelSetup.
  explicit BertModel(BertModelSetup& setup);

  /// @see BertModel::BertModel(BertModelSetup&)
  void init(BertModelSetup& setup);

  /// @see BertModel::BertModel(string, unordered_map)
  void init(
      const std::string& modelGgufPath,
      const std::unordered_map<std::string, std::string>& config,
      const std::string& backendsDir);

  /// @brief Deletes model implementation.
  ~BertModel() override;

  BertModel(const BertModel&) = delete;
  BertModel& operator=(const BertModel&) = delete;
  BertModel(BertModel&&) = delete;
  BertModel& operator=(BertModel&&) = delete;
  /// @brief Processes text to embeddings using Bert encoder and syncs the
  /// result back to the host. Processes the entire prompt as a single sequence
  /// without splitting. Throws ContextOverflow error if prompt exceeds model
  /// effective runtime context size.
  /// @returns A host vector of embeddings with one embedding per prompt.
  /// @note Awaits for initialization to finish if its loading .gguf shards
  /// asynchronously.
  BertEmbeddings encodeHostF32(const std::string& prompt);

  /// @brief Process text of embeddings of an already pre-processed input.
  /// @note Awaits for initialization to finish if its loading .gguf shards
  /// asynchronously.
  BertEmbeddings encodeHostF32(const std::vector<std::string>& prompts);

  /// @brief Process an array of sequences. Each sequence is processed as-is
  /// without splitting by delimiter. Sequences are processed in batches and one
  /// embedding is returned per sequence. Throws ContextOverflow error if any
  /// sequence exceeds the effective runtime context size.
  /// @param sequenceArray Array of sequence strings to process (no
  /// preprocessing/splitting)
  /// @returns Embeddings with one embedding per sequence
  /// @note Awaits for initialization to finish if its loading .gguf shards
  /// asynchronously.
  /// @note This is an internal method - call via process() which handles
  /// sequences array detection and parsing
  BertEmbeddings
  encodeHostF32Sequences(const std::vector<std::string>& sequenceArray);

  /// @brief Read-only access to the context.
  const llama_context* getCtx() const;

  /// @brief Read-only access to the model.
  const llama_model* getModel() const;

  std::vector<std::string> preprocessPrompt(const std::string& prompt) const;

  void cancel() const final;

  [[nodiscard]] std::string getName() const final { return "BertModel"; }

  void reset();

  /// @brief Process input (string or vector of strings) and return embeddings
  /// @param input Either std::string or std::vector<std::string>
  /// @returns Embeddings with one embedding per input sequence
  std::any process(const std::any& input) final;

  [[nodiscard]] qvac_lib_inference_addon_cpp::RuntimeStats
  runtimeStats() const final;

  bool isLoaded() const;

  const common_params& getCommonParams() const;

  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard) final;

  void unloadWeights() {}

  enum llama_pooling_type pooling_type;
  int n_embd;

  void initializeBackend(
      const std::string& backendsDir = "",
      const std::string& openclCacheDir = "");

  /// @brief Ensure model is initialized
  void waitForLoadInitialization() final {
    initLoader_.waitForLoadInitialization();
  }

private:
  /// @param prompts_size: Number of parsed prompts after splitting into lines.
  std::vector<std::vector<int32_t>>
  tokenizeInput(const std::vector<std::string>& prompts) const;

  /// @brief n_embd_count: Output parameter, the number of embeddings.
  BertEmbeddings processBatched(
      const std::vector<std::vector<int32_t>>& inputs,
      std::size_t nPrompts) const;
};
// NOLINTEND(cppcoreguidelines-non-private-member-variables-in-classes,
// readability-avoid-const-params-in-decls)
