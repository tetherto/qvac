#ifndef QVAC_ABOT_TRACE_H
#define QVAC_ABOT_TRACE_H

#include <cstring>

inline bool& abot_trace_active() { static bool value = false; return value; }
inline size_t& abot_trace_sequence() { static size_t value = 0; return value; }

inline void abot_trace_boundary(const char* stage, int block, int step) {
    if (!abot_diag_dir() || !std::getenv("SD_ABOT_DIAGNOSTIC_TRACE")) return;
    if (block == 0 && std::strcmp(stage, "initial-noise") == 0) {
        abot_trace_active() = true;
        abot_trace_sequence() = 0;
    }
    if (block == 0 && step == 0 && std::strcmp(stage, "flow") == 0) {
        abot_trace_active() = false;
        std::ofstream file(std::string(abot_diag_dir()) + "/operations.jsonl", std::ios::app);
        file << "{\"event\":\"end\",\"nodes\":" << abot_trace_sequence() << "}\n";
        if (!file) std::abort();
    }
}

inline void abot_trace_metadata(std::ostream& out, const ggml_tensor* tensor) {
    out << "{\"name\":" << std::quoted(tensor->name) << ",\"type\":" << int(tensor->type)
        << ",\"op\":" << std::quoted(ggml_op_name(tensor->op)) << ",\"ne\":[";
    for (int d = 0; d < 4; ++d) { if (d) out << ','; out << tensor->ne[d]; }
    out << "],\"nb\":[";
    for (int d = 0; d < 4; ++d) { if (d) out << ','; out << tensor->nb[d]; }
    out << "]}";
}

inline uint64_t abot_trace_hash(const unsigned char* data, const ggml_tensor* tensor) {
    uint64_t hash = UINT64_C(14695981039346656037);
    const size_t size = ggml_type_size(tensor->type);
    // Hash only logical elements: view strides may span unused allocation bytes.
    for (int64_t i3 = 0; i3 < tensor->ne[3]; ++i3)
        for (int64_t i2 = 0; i2 < tensor->ne[2]; ++i2)
            for (int64_t i1 = 0; i1 < tensor->ne[1]; ++i1)
                for (int64_t i0 = 0; i0 < tensor->ne[0]; ++i0) {
                    const size_t offset = i0*tensor->nb[0] + i1*tensor->nb[1] + i2*tensor->nb[2] + i3*tensor->nb[3];
                    for (size_t byte = 0; byte < size; ++byte) {
                        hash ^= data[offset + byte];
                        hash *= UINT64_C(1099511628211);
                    }
                }
    return hash;
}

inline bool abot_trace_node(ggml_tensor* tensor, bool ask) {
    const bool selected = abot_trace_active() && tensor->op != GGML_OP_NONE;
    if (ask) return selected;
    if (!selected) return true;
    const size_t index = abot_trace_sequence()++;
    if (index >= 10000) std::abort();
    std::ofstream file(std::string(abot_diag_dir()) + "/operations.jsonl", std::ios::app);
    file << "{\"event\":\"node\",\"index\":" << index << ",\"output\":";
    abot_trace_metadata(file, tensor);
    file << ",\"sources\":[";
    bool first = true;
    for (int i = 0; i < GGML_MAX_SRC; ++i) {
        if (!tensor->src[i]) continue;
        if (!first) file << ',';
        first = false;
        abot_trace_metadata(file, tensor->src[i]);
    }
    file << "],\"fnv1a64\":";
    const bool supported = tensor->type == GGML_TYPE_F32 || tensor->type == GGML_TYPE_F16 ||
                           tensor->type == GGML_TYPE_BF16 || tensor->type == GGML_TYPE_I32;
    if (!supported || ggml_nbytes(tensor) > 512 * 1024 * 1024) {
        file << "null";
    } else {
        std::vector<unsigned char> bytes(ggml_nbytes(tensor));
        ggml_backend_tensor_get(tensor, bytes.data(), 0, bytes.size());
        std::ostringstream hash;
        hash << std::hex << std::setfill('0') << std::setw(16) << abot_trace_hash(bytes.data(), tensor);
        file << std::quoted(hash.str());
        const char* target = std::getenv("SD_ABOT_TRACE_DUMP");
        if (target && *target && std::strcmp(tensor->name, target) == 0) {
            // Exact-name filter only; retain raw activations for a follow-up.
            std::ofstream raw(std::string(abot_diag_dir()) + "/trace-" + std::to_string(index) + ".bin", std::ios::binary);
            raw.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
            if (!raw) std::abort();
        }
    }
    file << "}\n";
    if (!file) std::abort();
    return true;
}

#endif
