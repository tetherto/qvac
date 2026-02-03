#include "FinetuneParamStore.hpp"

namespace qvac_lib_inference_addon_llama_detail {
namespace {
std::mutex g_storeMutex;
std::unordered_map<void*, qvac_lib_inference_addon_cpp::FinetuningParameters>
    g_store;
} // namespace

void put(
    void* key,
    const qvac_lib_inference_addon_cpp::FinetuningParameters& params) {
  if (key == nullptr) {
    return;
  }
  std::scoped_lock lock{g_storeMutex};
  g_store[key] = params;
}

bool take(
    void* key,
    qvac_lib_inference_addon_cpp::FinetuningParameters& outParams) {
  if (key == nullptr) {
    return false;
  }
  std::scoped_lock lock{g_storeMutex};
  auto it = g_store.find(key);
  if (it == g_store.end()) {
    return false;
  }
  outParams = it->second;
  g_store.erase(it);
  return true;
}

void erase(void* key) {
  if (key == nullptr) {
    return;
  }
  std::scoped_lock lock{g_storeMutex};
  g_store.erase(key);
}

}
