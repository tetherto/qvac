#pragma once

#include <any>
#include <atomic>
#include <functional>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

#include <llama/common/common.h>
#include <llama/common/log.h>

#include "LlamaLazyInitializeBackend.hpp"
#include "qvac-lib-inference-addon-cpp/GGUFShards.hpp"
#include "qvac-lib-inference-addon-cpp/InitLoader.hpp"
#include "qvac-lib-inference-addon-cpp/ModelInterfaces.hpp"
#include "qvac-lib-inference-addon-cpp/RuntimeStats.hpp"
#include "utils.hpp"

#if defined(_MSC_VER)
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
  common_init_result result;
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
  const GGUFShards shards_;
  friend class InitLoader;
  InitLoader initLoader_;
  bool isStreaming_ = false;
  std::map<std::string, std::unique_ptr<std::basic_streambuf<char>>>
      singleGgufStreamedFiles_;
  std::optional<LlamaBackendsHandle> backendsHandle_;
  mutable std::atomic<bool> stopCancelled_{false};
  int64_t runtimeBackendDevice_ = 0;

public:
  // These using definitions are accessed by the Addon<BertModel> template.
  using OutputType = BertEmbeddings;
  using Input = std::variant<std::string, std::vector<std::string>>;
  using InputView = Input;
  using Output = OutputType;

  using TokenizerHandle = void*;

  /// @brief This constructor allows to specify model to load more clearly and
  /// override default common params by a configuration object.
  ///
  /// @param config: Configuration key/value map.
  BertModel(
      const std::string& modelGgufPath,
      const std::unordered_map<std::string, std::string>& config,
      const std::string& backendsDir = "");

  /// @brief Construct with already parsed parameters.
  explicit BertModel(common_params& params);

  /// @see BertModel::BertModel(common_params)
  void init(common_params& params);

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
  /// training context size.
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
  /// sequence exceeds model training context size.
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

  void setWeightsForFile(
      const std::string& filename,
      std::unique_ptr<std::basic_streambuf<char>>&& shard) final;

  void unloadWeights() {}

  enum llama_pooling_type pooling_type;
  int n_embd;

  void initializeBackend(const std::string& backendsDir = "");

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
