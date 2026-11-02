#include "EmbedderFit.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <numeric>
#include <utility>
#include <vector>

#include <gguf.h>

namespace qvac_lib_inference_addon_bci {

namespace {

constexpr uint32_t K_EMBEDDER_MAGIC = 0x42434945;
constexpr uint32_t K_EMBEDDER_FORMAT_VERSION = 1;
constexpr std::array<char, 4> K_GGUF_MAGIC = {'G', 'G', 'U', 'F'};
constexpr uint32_t K_DESCRIPTION_VERSION = 1;
constexpr const char* K_DESCRIPTION_ARCHITECTURE = "bci_embedder";
constexpr uint64_t K_ELEMENT_BYTES = sizeof(float);
constexpr uint32_t K_MAX_PERIODS = 1U << 16U;
constexpr const char* K_EMBEDDER_FILENAME = "bci-embedder.bin";
constexpr const char* K_PATH_SEPARATORS = "/\\";
constexpr const char* K_CURRENT_DIRECTORY = ".";

constexpr size_t K_HEADER_FIELDS = 8;
constexpr size_t K_NUM_FEATURES_FIELD = 0;
constexpr size_t K_NUM_DAYS_FIELD = 5;
constexpr size_t K_NUM_MONTHS_FIELD = 6;
constexpr size_t K_RANK_FIELD = 7;

constexpr size_t K_CONV_ARRAYS = 4;
constexpr size_t K_DAY_ARRAYS = 3;
constexpr size_t K_MONTH_ARRAYS = 2;
constexpr std::array<const char*, K_DAY_ARRAYS> K_DAY_ARRAY_NAMES = {
    "a", "b", "bias"};
constexpr std::array<const char*, K_MONTH_ARRAYS> K_MONTH_ARRAY_NAMES = {
    "weight", "bias"};

struct EmbedderShape {
  uint32_t numFeatures = 0;
  uint32_t numDays = 0;
  uint32_t numMonths = 0;
  uint32_t rank = 0;
};

template <size_t N> using PeriodArrays = std::vector<std::array<uint64_t, N>>;

struct EmbedderArrays {
  std::vector<uint64_t> conv;
  uint64_t sessions = 0;
  PeriodArrays<K_DAY_ARRAYS> days;
  PeriodArrays<K_MONTH_ARRAYS> months;
};

struct EmbedderLayout {
  EmbedderShape shape;
  EmbedderArrays arrays;
};

bool periodsAreBounded(const EmbedderShape& shape) {
  return shape.numDays <= K_MAX_PERIODS && shape.numMonths <= K_MAX_PERIODS;
}

class EmbedderFileReader {
public:
  explicit EmbedderFileReader(const std::string& path)
      : in_(path, std::ios::binary) {
    std::error_code error;
    size_ = std::filesystem::file_size(path, error);
    if (error) {
      in_.setstate(std::ios::failbit);
    }
  }

  [[nodiscard]] bool ok() const {
    return static_cast<bool>(in_) && consumed_ <= size_;
  }

  uint32_t u32() {
    uint32_t value = 0;
    in_.read(reinterpret_cast<char*>(&value), sizeof(value));
    consumed_ += sizeof(value);
    return value;
  }

  uint64_t skipArray() {
    const uint64_t count = u32();
    const uint64_t bytes = count * K_ELEMENT_BYTES;
    in_.seekg(static_cast<std::streamoff>(bytes), std::ios::cur);
    consumed_ += bytes;
    return count;
  }

private:
  std::ifstream in_;
  uint64_t size_ = 0;
  uint64_t consumed_ = 0;
};

bool isDescription(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  std::array<char, K_GGUF_MAGIC.size()> magic{};
  in.read(magic.data(), magic.size());
  return in.gcount() == static_cast<std::streamsize>(magic.size()) &&
         magic == K_GGUF_MAGIC;
}

std::array<uint32_t, K_HEADER_FIELDS>
readHeaderFields(EmbedderFileReader& reader) {
  std::array<uint32_t, K_HEADER_FIELDS> fields{};
  for (auto& field : fields) {
    field = reader.u32();
  }
  return fields;
}

EmbedderShape
shapeFromHeader(const std::array<uint32_t, K_HEADER_FIELDS>& fields) {
  return EmbedderShape{
      fields[K_NUM_FEATURES_FIELD],
      fields[K_NUM_DAYS_FIELD],
      fields[K_NUM_MONTHS_FIELD],
      fields[K_RANK_FIELD]};
}

template <size_t N>
std::array<uint64_t, N> skipArrays(EmbedderFileReader& reader) {
  std::array<uint64_t, N> lengths{};
  for (auto& length : lengths) {
    length = reader.skipArray();
  }
  return lengths;
}

template <size_t N>
PeriodArrays<N> skipPeriods(EmbedderFileReader& reader, uint32_t periods) {
  PeriodArrays<N> lengths(periods);
  for (auto& period : lengths) {
    period = skipArrays<N>(reader);
  }
  return lengths;
}

std::optional<EmbedderLayout> readEmbedderFile(const std::string& path) {
  EmbedderFileReader reader(path);
  if (!reader.ok() || reader.u32() != K_EMBEDDER_MAGIC ||
      reader.u32() != K_EMBEDDER_FORMAT_VERSION) {
    return std::nullopt;
  }

  EmbedderLayout layout;
  layout.shape = shapeFromHeader(readHeaderFields(reader));
  if (!reader.ok() || !periodsAreBounded(layout.shape)) {
    return std::nullopt;
  }

  const auto conv = skipArrays<K_CONV_ARRAYS>(reader);
  layout.arrays.conv.assign(conv.begin(), conv.end());
  layout.arrays.sessions = reader.skipArray();
  layout.arrays.days = skipPeriods<K_DAY_ARRAYS>(reader, layout.shape.numDays);
  layout.arrays.months =
      skipPeriods<K_MONTH_ARRAYS>(reader, layout.shape.numMonths);

  if (!reader.ok()) {
    return std::nullopt;
  }
  return layout;
}

struct GgufDeleter {
  void operator()(gguf_context* ctx) const { gguf_free(ctx); }
};

using GgufPtr = std::unique_ptr<gguf_context, GgufDeleter>;

std::optional<uint32_t>
descriptionU32(const gguf_context* ctx, const char* key) {
  const int64_t id = gguf_find_key(ctx, key);
  if (id < 0 || gguf_get_kv_type(ctx, id) != GGUF_TYPE_UINT32) {
    return std::nullopt;
  }
  return gguf_get_val_u32(ctx, id);
}

bool describesEmbedder(const gguf_context* ctx) {
  const int64_t architecture = gguf_find_key(ctx, "general.architecture");
  return architecture >= 0 &&
         gguf_get_kv_type(ctx, architecture) == GGUF_TYPE_STRING &&
         std::strcmp(
             gguf_get_val_str(ctx, architecture), K_DESCRIPTION_ARCHITECTURE) ==
             0 &&
         descriptionU32(ctx, "fit_description.version") ==
             K_DESCRIPTION_VERSION;
}

std::optional<uint64_t>
descriptionArray(const gguf_context* ctx, const std::string& name) {
  const int64_t id = gguf_find_tensor(ctx, name.c_str());
  if (id < 0) {
    return std::nullopt;
  }
  const ggml_type type = gguf_get_tensor_type(ctx, id);
  if (type != GGML_TYPE_F32 && type != GGML_TYPE_I32) {
    return std::nullopt;
  }
  return gguf_get_tensor_size(ctx, id) / K_ELEMENT_BYTES;
}

template <size_t N>
std::optional<std::array<uint64_t, N>> descriptionArrays(
    const gguf_context* ctx, const std::string& prefix,
    const std::array<const char*, N>& names) {
  std::array<uint64_t, N> lengths{};
  for (size_t field = 0; field < N; ++field) {
    const auto length = descriptionArray(ctx, prefix + names[field]);
    if (!length) {
      return std::nullopt;
    }
    lengths[field] = *length;
  }
  return lengths;
}

std::array<const char*, K_CONV_ARRAYS> convArrayNames() {
  return {"0", "1", "2", "3"};
}

template <size_t N>
std::optional<PeriodArrays<N>> descriptionPeriods(
    const gguf_context* ctx, const char* period, uint32_t count,
    const std::array<const char*, N>& names) {
  PeriodArrays<N> lengths;
  for (uint32_t index = 0; index < count; ++index) {
    const auto arrays = descriptionArrays(
        ctx, std::string(period) + "." + std::to_string(index) + ".", names);
    if (!arrays) {
      return std::nullopt;
    }
    lengths.push_back(*arrays);
  }
  return lengths;
}

std::optional<EmbedderShape> descriptionShape(const gguf_context* ctx) {
  const auto numFeatures = descriptionU32(ctx, "bci_embedder.num_features");
  const auto numDays = descriptionU32(ctx, "bci_embedder.num_days");
  const auto numMonths = descriptionU32(ctx, "bci_embedder.num_months");
  const auto rank = descriptionU32(ctx, "bci_embedder.rank");
  if (!numFeatures || !numDays || !numMonths || !rank) {
    return std::nullopt;
  }
  const EmbedderShape shape{*numFeatures, *numDays, *numMonths, *rank};
  if (!periodsAreBounded(shape)) {
    return std::nullopt;
  }
  return shape;
}

std::optional<EmbedderLayout> readEmbedderDescription(const std::string& path) {
  gguf_init_params params = {};
  params.no_alloc = true;
  params.ctx = nullptr;
  const GgufPtr ctx(gguf_init_from_file(path.c_str(), params));
  if (!ctx || !describesEmbedder(ctx.get())) {
    return std::nullopt;
  }

  const auto shape = descriptionShape(ctx.get());
  const auto conv = descriptionArrays(ctx.get(), "conv.", convArrayNames());
  const auto sessions = descriptionArray(ctx.get(), "session_to_day");
  if (!shape || !conv || !sessions) {
    return std::nullopt;
  }

  auto days =
      descriptionPeriods(ctx.get(), "day", shape->numDays, K_DAY_ARRAY_NAMES);
  auto months = descriptionPeriods(
      ctx.get(), "month", shape->numMonths, K_MONTH_ARRAY_NAMES);
  if (!days || !months) {
    return std::nullopt;
  }
  return EmbedderLayout{
      *shape,
      EmbedderArrays{
          std::vector<uint64_t>(conv->begin(), conv->end()),
          *sessions,
          std::move(*days),
          std::move(*months)}};
}

bool periodsMatchShape(const EmbedderLayout& layout) {
  const uint64_t nf = layout.shape.numFeatures;
  const uint64_t r = layout.shape.rank;
  const auto dayMatches = [&](const auto& day) {
    return day[0] == nf * r && day[1] == r * nf && day[2] == nf;
  };
  const auto monthMatches = [&](const auto& month) {
    return month[0] == nf * nf && month[1] == nf;
  };
  return std::all_of(
             layout.arrays.days.begin(),
             layout.arrays.days.end(),
             dayMatches) &&
         std::all_of(
             layout.arrays.months.begin(),
             layout.arrays.months.end(),
             monthMatches);
}

template <size_t N> uint64_t periodElements(const PeriodArrays<N>& periods) {
  return std::accumulate(
      periods.begin(),
      periods.end(),
      uint64_t{0},
      [](uint64_t total, const auto& period) {
        return total +
               std::accumulate(period.begin(), period.end(), uint64_t{0});
      });
}

EmbedderFootprint footprintOf(const EmbedderLayout& layout) {
  const uint64_t nf = layout.shape.numFeatures;
  const bool cachesProjection =
      layout.shape.rank > 0 && layout.shape.numDays > 0;
  const uint64_t largestConv =
      *std::max_element(layout.arrays.conv.begin(), layout.arrays.conv.end());

  EmbedderFootprint footprint;
  footprint.residentBytes =
      (periodElements(layout.arrays.days) +
       periodElements(layout.arrays.months) + layout.arrays.sessions) *
      K_ELEMENT_BYTES;
  footprint.projectionCacheBytes =
      cachesProjection ? (nf * nf + nf) * K_ELEMENT_BYTES : 0;
  footprint.largestTransientBytes = largestConv * K_ELEMENT_BYTES;
  return footprint;
}

} // namespace

uint64_t EmbedderFootprint::hostBytes() const {
  return std::max(largestTransientBytes, residentBytes + projectionCacheBytes);
}

std::string colocatedEmbedderPath(const std::string& modelPath) {
  const auto lastSeparator = modelPath.find_last_of(K_PATH_SEPARATORS);
  const std::string directory = lastSeparator != std::string::npos
                                    ? modelPath.substr(0, lastSeparator)
                                    : K_CURRENT_DIRECTORY;
  return directory + "/" + K_EMBEDDER_FILENAME;
}

std::optional<EmbedderFootprint> measureEmbedder(const std::string& path) {
  const auto layout = isDescription(path) ? readEmbedderDescription(path)
                                          : readEmbedderFile(path);
  if (!layout || !periodsMatchShape(*layout)) {
    return std::nullopt;
  }
  return footprintOf(*layout);
}

} // namespace qvac_lib_inference_addon_bci
