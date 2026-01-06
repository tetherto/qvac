#include <algorithm>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <memory>
#include <span>

#include <llama/common/arg.h>

#include "model-interface/BertModel.h"
#include "uint8-buff-stream.h"

std::vector<uint8_t> load_file_into_buffer(const char* const model_path) {
  std::ifstream file_stream(model_path, std::ios::binary | std::ios::ate);
  if (!file_stream) {
    fprintf(
        stderr,
        "Failed to open file %s for reading into streambuf\n",
        model_path);
    exit(EXIT_FAILURE);
  }

  const size_t file_size = file_stream.tellg();
  file_stream.seekg(0, std::ios::beg);

  static_assert(
      sizeof(std::uint8_t) == sizeof(char),
      "uint8_t must be same size as char");
  std::vector<std::uint8_t> buffer(file_size);
  if (!file_stream.read((char*)buffer.data(), file_size)) {
    fprintf(stderr, "Failed to read entire file into buffer\n");
    exit(EXIT_FAILURE);
  }

  return buffer;
}

void fulfill_files_async(
    BertModel& model_instance, const char* const model_path) {
  // Extract pattern from first file path
  std::string path(model_path);

  // Split by '-'
  std::vector<std::string> parts;
  std::stringstream ss(path);
  std::string item;
  while (std::getline(ss, item, '-')) {
    parts.push_back(item);
  }

  // Split the last part by '.'
  std::string last_part = parts.back();
  parts.pop_back();
  size_t dot_pos = last_part.find('.');
  if (dot_pos != std::string::npos) {
    parts.push_back(last_part.substr(0, dot_pos));
    parts.push_back(last_part.substr(dot_pos + 1)); // extension
  } else {
    parts.push_back(last_part);
  }

  // Check if we have enough parts
  if (parts.size() < 4) {
    fprintf(stderr, "Model path does not contain expected pattern\n");
    exit(EXIT_FAILURE);
  }

  // Get total files from [-2] position (before the extension)
  int total_files = std::stoi(parts[parts.size() - 2]);

  // Get base path by joining all parts except -start-of-end.gguf
  std::string base_path;
  for (size_t i = 0; i < parts.size() - 4; i++) {
    if (i > 0) {
      base_path += "-";
    }
    base_path += parts[i];
  }

  std::string tensor_list_path = base_path + ".tensors.txt";
  std::vector<std::string> paths;

  std::unique_ptr<Uint8BufferStreamBuf> streambuf_listshards =
      std::make_unique<Uint8BufferStreamBuf>(
          load_file_into_buffer(tensor_list_path.c_str()));
  std::string tensor_list_filename =
      std::filesystem::path(tensor_list_path).filename().string();
  model_instance.set_weights_for_file(
      tensor_list_filename, std::move(streambuf_listshards));

  for (int i = 1; i <= total_files; i++) {
    char numbered_path[1024];
    snprintf(
        numbered_path,
        sizeof(numbered_path),
        "%s-%05d-of-%05d.gguf",
        base_path.c_str(),
        i,
        total_files);
    paths.emplace_back(numbered_path);

    std::unique_ptr<Uint8BufferStreamBuf> streambuf_shard =
        std::make_unique<Uint8BufferStreamBuf>(
            load_file_into_buffer(numbered_path));
    std::string numbered_path_filename =
        std::filesystem::path(numbered_path).filename().string();
    model_instance.set_weights_for_file(
        numbered_path_filename, std::move(streambuf_shard));
  }
}

int main(int argc, char** argv) {

  common_params params;

  if (!common_params_parse(argc, argv, params, LLAMA_EXAMPLE_EMBEDDING)) {
    return 1;
  }

  params.embedding = true;

  // if the number of prompts that would be encoded is known in advance, it's
  // more efficient to specify the
  //   --parallel argument accordingly. for convenience, if not specified, we
  //   fallback to unified KV cache in order to support any number of prompts
  if (params.n_parallel == 1) {
    params.kv_unified = true;
  }

  // For non-causal models, batch size must be equal to ubatch size
  params.n_ubatch = params.n_batch;

  // The default prompt should produce the following results in the cosine
  // similarity matrix.
  //
  // 1. A very high correlation Between 'This/That is a happy person' (0.97)
  // | This i That i Has no what i how to Beijin sortin
  // | T1.00   0.97   0.80   0.78   0.76   0.80   0.78   0.75 This is a
  //
  // 2. A high correlation between 'What is the capital..?' and 'Beijing':
  // (0.90) | This i That i Has no what i how to Beijin sortin | 0.78   0.77
  // 0.77   1.00   0.76   0.90   0.76   0.74 what is th
  //
  // 3. Significant correlation between 'how to impl..?' and 'sorting
  // algorithms' (0.83) | This i That i Has no what i how to Beijin sortin |
  // 0.76   0.75   0.77   0.76   1.00   0.77   0.83   0.70 how to imp
  params.prompt = R"(This is a happy person
That is a very happy person
Has nothing to do
what is the capital of China?
how to implement quick sort in python?
Beijing
sorting algorithms
)";

  BertModel model_instance(params);
  const llama_model* model = model_instance.get_model();
  std::optional<std::thread> async_load_thread;
  if (params.model.path.find("-of-") != std::string::npos) {
    async_load_thread.emplace(
        [&model_instance, model_path = params.model.path]() {
          fulfill_files_async(model_instance, model_path.c_str());
        });
  }

  const std::vector<std::string> prompts =
      model_instance.preprocess_prompt(params.prompt);
  const std::size_t n_prompts = prompts.size();
  const BertEmbeddings embeddings = model_instance.encode_host_f32(prompts);
  const int n_embd = (int)embeddings.embeddingSize();
  const int n_embd_count = (int)embeddings.size();

  if (async_load_thread.has_value()) {
    async_load_thread->join();
    async_load_thread.reset();
  }

  if (params.embd_out.empty()) {
    LOG("\n");

    if (model_instance.pooling_type == LLAMA_POOLING_TYPE_NONE) {
      for (int j = 0; j < n_embd_count; j++) {
        LOG("embedding %d: ", j);
        for (int i = 0; i < std::min(3, n_embd); i++) {
          if (params.embd_normalize == 0) {
            LOG("%6.0f ", embeddings[j][i]);
          } else {
            LOG("%9.6f ", embeddings[j][i]);
          }
        }
        LOG(" ... ");
        for (int i = n_embd - 3; i < n_embd; i++) {
          if (params.embd_normalize == 0) {
            LOG("%6.0f ", embeddings[j][i]);
          } else {
            LOG("%9.6f ", embeddings[j][i]);
          }
        }
        LOG("\n");
      }
    } else if (model_instance.pooling_type == LLAMA_POOLING_TYPE_RANK) {
      const uint32_t n_cls_out = llama_model_n_cls_out(model);
      std::vector<std::string> cls_out_labels;

      for (uint32_t i = 0; i < n_cls_out; i++) {
        const char* label = llama_model_cls_label(model, i);
        const std::string label_i(label == nullptr ? "" : label);
        cls_out_labels.emplace_back(
            label_i.empty() ? std::to_string(i) : label_i);
      }

      for (int j = 0; j < n_embd_count; j++) {
        for (uint32_t i = 0; i < n_cls_out; i++) {
          // NOTE: if you change this log - update the tests in ci/run.sh
          if (n_cls_out == 1) {
            LOG("rerank score %d: %8.3f\n", j, embeddings[j][0]);
          } else {
            LOG("rerank score %d: %8.3f [%s]\n",
                j,
                embeddings[j][i],
                cls_out_labels[i].c_str());
          }
        }
      }
    } else {
      // print the first part of the embeddings or for a single prompt, the full
      // embedding
      for (int j = 0; j < n_prompts; j++) {
        LOG("embedding %d: ", j);
        for (int i = 0; i < (n_prompts > 1 ? std::min(16, n_embd) : n_embd);
             i++) {
          if (params.embd_normalize == 0) {
            LOG("%6.0f ", embeddings[j][i]);
          } else {
            LOG("%9.6f ", embeddings[j][i]);
          }
        }
        LOG("\n");
      }

      // print cosine similarity matrix
      if (n_prompts > 1) {
        LOG("\n");
        LOG("cosine similarity matrix:\n\n");
        for (int i = 0; i < n_prompts; i++) {
          LOG("%6.6s ", prompts[i].c_str());
        }
        LOG("\n");
        for (int i = 0; i < n_prompts; i++) {
          for (int j = 0; j < n_prompts; j++) {
            float sim = common_embd_similarity_cos(
                embeddings[i].data(), embeddings[j].data(), n_embd);
            LOG("%6.2f ", sim);
          }
          LOG("%1.10s", prompts[i].c_str());
          LOG("\n");
        }
      }
    }
  }

  if (params.embd_out == "json" || params.embd_out == "json+" ||
      params.embd_out == "array") {
    const bool notArray = params.embd_out != "array";

    LOG(notArray ? "{\n  \"object\": \"list\",\n  \"data\": [\n" : "[");
    for (int j = 0;;) { // at least one iteration (one prompt)
      if (notArray)
        LOG("    {\n      \"object\": \"embedding\",\n      \"index\": %d,\n   "
            "   \"embedding\": ",
            j);
      LOG("[");
      for (int i = 0;;) { // at least one iteration (n_embd > 0)
        LOG(params.embd_normalize == 0 ? "%1.0f" : "%1.7f", embeddings[j][i]);
        i++;
        if (i < n_embd)
          LOG(",");
        else
          break;
      }
      LOG(notArray ? "]\n    }" : "]");
      j++;
      if (j < n_embd_count)
        LOG(notArray ? ",\n" : ",");
      else
        break;
    }
    LOG(notArray ? "\n  ]" : "]\n");

    if (params.embd_out == "json+" && n_prompts > 1) {
      LOG(",\n  \"cosineSimilarity\": [\n");
      for (int i = 0;;) { // at least two iteration (n_embd_count > 1)
        LOG("    [");
        for (int j = 0;;) { // at least two iteration (n_embd_count > 1)
          float sim = common_embd_similarity_cos(
              embeddings[i].data(), embeddings[j].data(), n_embd);
          LOG("%6.2f", sim);
          j++;
          if (j < n_embd_count)
            LOG(", ");
          else
            break;
        }
        LOG(" ]");
        i++;
        if (i < n_embd_count)
          LOG(",\n");
        else
          break;
      }
      LOG("\n  ]");
    }

    if (notArray)
      LOG("\n}\n");
  }

  LOG("\n");
  llama_perf_context_print(model_instance.get_ctx());

  qvac_lib_inference_addon_cpp::RuntimeStats runtime_stats =
      model_instance.runtimeStats();

  for (const auto& stat : runtime_stats) {
    const auto& key = stat.first;
    const auto& value = stat.second;

    std::visit(
        [&](auto&& v) {
          LOG("Addon Inference Stats - %s: %s\n",
              key.c_str(),
              std::to_string(v).c_str());
        },
        value);
  }

  return 0;
}
