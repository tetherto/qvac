# String API conventions

**Status:** Proposal for team review (quality improvement)

**Primary decision:** Prefer **`std::string_view`** in interfaces when the callee does not need to own or mutate the string and does not require null termination.

## Why this exists

String handling is one of the most frequent sources of hidden allocations in C++ interfaces. This convention aims to:

- minimize accidental copies in read-only paths,
- make ownership transfer explicit in sink paths,
- keep interfaces consistent across native addon code.

## Rules

1. **Read-only input (no ownership):** use **`std::string_view`**.
2. **Sink input (callee unconditionally stores/owns):** use **`std::string&&`** and move into storage.
3. **Downstream API requires `std::string` reference semantics:** keep or pass **`std::string`** / **`const std::string&`** as required.
4. **Null-termination or C API boundary:** use **`const char*`** or **`std::string`** as that API demands.

## Rationale for `std::string&&` sinks

For true sink APIs, `std::string&&` enforces intent at the call site:

- Caller must choose explicitly:
  - move: `fn(std::move(s))`
  - copy: `fn(std::string{s})` (or equivalent)
- This prevents accidental copy when a caller forgets `std::move`.
- It makes ownership transfer visible in code review.

Trade-off:

- This is stricter and less familiar than by-value sink APIs.
- Some call sites become slightly more verbose.
- Team onboarding needs examples and review discipline.

## Usage examples

### 1) Read-only API: `std::string_view`

```cpp
bool hasModel(std::string_view modelId) {
  return modelIndex_.contains(modelId);
}
```

Use this when the function only reads the string.

### 2) Sink API: `std::string&&`

```cpp
void setModelId(std::string&& modelId) {
  modelId_ = std::move(modelId);
}
```

Call sites:

```cpp
std::string id = computeId();
setModelId(std::move(id));     // explicit move
setModelId(std::string{"foo"}); // explicit temporary
```

### 3) Intentional copy into sink

```cpp
std::string source = getSharedName();
setModelId(std::string{source}); // explicit copy is visible
```

### 4) C API boundary

```cpp
void callLegacyApi(const char* value) {
  legacy_api_consume(value);
}
```

Prefer `const char*` here when the API only needs a null-terminated view. This avoids constructing a temporary `std::string` when callers already have a C string (for example a string literal).

## Maps

**`TransparentStringMap`** (`packages/inference-addon-cpp/src/inference-addon-cpp/TransparentStringMap.hpp`) is the default for unordered maps keyed by **`std::string`** in C++ addon code.

Its transparent hash/equal allows **`find` / `contains` / `erase`** with **`std::string_view`** (and other string-like keys) without temporary `std::string` allocation:

```cpp
TransparentStringMap<int> counts;
counts.emplace("foo", 1);

std::string_view key = "foo";
auto it = counts.find(key); // no temporary std::string
```

Use plain **`std::unordered_map<std::string, ...>`** only when there is a documented reason (for example an external API signature requiring that exact type).

## Do's and don'ts

Do:

- Use `std::string_view` for read-only string inputs; this keeps call paths allocation-free when caller data is already contiguous.
- Use `std::string&&` for true sinks and move into storage (`field = std::move(arg)`); this avoids copy-heavy assignment paths.
- Use `const std::string&` when integrating with downstream APIs that already require `std::string` reference semantics.
- Keep C-string boundaries as `const char*` when the callee only needs null-terminated input.
- Use `TransparentStringMap` lookups with `std::string_view` (or literal keys) to avoid temporary key materialization.
- Make intentional copies explicit (`fn(std::string{source})`) so cost is visible in code review.

Don't:

- Do not use `const std::string&` as a default "safe" read-only type for all APIs.  
  Cost impact: callers with literals/C strings often pay temporary `std::string` construction (and, with exceptions enabled, extra unwind/cleanup paths).
  ```cpp
  bool hasModel(const std::string& id); // avoid for read-only
  hasModel("model-id");                 // may construct temporary std::string
  ```
- Do not pass a sink argument by `const std::string&` and then copy internally.  
  Cost impact: copy-oriented assignment path (`memcpy`/reallocation branches) instead of transfer-oriented move path.
  ```cpp
  void setName(const std::string& name) {
    name_ = name; // copy path
  }
  ```
- Do not accept `std::string_view` and store it beyond call scope unless lifetime is guaranteed externally.  
  Cost impact: correctness risk (dangling view), which is worse than any micro-optimization.
  ```cpp
  struct BadCache {
    std::string_view key; // non-owning storage
    void set(std::string_view k) { key = k; } // may dangle after call
  };
  ```
- Do not convert to `std::string` before every map lookup when using `TransparentStringMap`.  
  Cost impact: avoidable allocation/copy churn on hot lookup paths.
  ```cpp
  TransparentStringMap<int> counts;
  std::string_view key = getKey();
  auto it = counts.find(std::string{key}); // avoid temporary allocation/copy
  ```
- Do not write `std::move` on `const std::string&` and expect a move.  
  Cost impact: it still copies (move from const is disabled), while making intent harder to read.
  ```cpp
  void setName(const std::string& name) {
    name_ = std::move(name); // still copies: name is const
  }
  ```
- Do not pass `std::string_view` directly to APIs that require `std::string&` or `const char*` without choosing a boundary strategy.  
  Cost impact: the function should expose when it needs `const std::string&` so callers that already have `std::string` avoid redundant allocation/copy. If that caller received the value as an input parameter, it may need to propagate the stricter requirement to its own callers. In practice, `const std::string&` and `const char*` requirements can bubble up through interface layers because they are stricter than `std::string_view`; migration toward `std::string_view` usually starts at leaf functions and then moves upward through the call chain.
  ```cpp
  void downstreamNeedsRef(const std::string& s);
  void legacyNeedsCStr(const char* s);

  // Wrapper accepts view...
  void wrapper(std::string_view view) {
    // ...but downstream requires std::string&, so we must allocate/copy.
    std::string owned{view};
    downstreamNeedsRef(owned);
  }

  // If caller already had std::string, this call path still pays wrapper-side churn.
  std::string alreadyOwned = getString();
  wrapper(alreadyOwned);

  std::string_view view = getView();
  legacyNeedsCStr(view.data()); // unsafe unless view is known null-terminated
  ```

Common pitfalls and fixes:

- **Pitfall:** `bool has(const std::string& id)` only reads `id`.  
  **Fix:** `bool has(std::string_view id)`.  
  **Why:** avoids temporary string creation for literals and many string-like callers.
- **Pitfall:** `void set(const std::string& name) { name_ = name; }` for a sink.  
  **Fix:** `void set(std::string&& name) { name_ = std::move(name); }`.  
  **Why:** enforces explicit move/copy decision at call sites.
- **Pitfall:** `lookup(std::string{keyView})` where `keyView` is `std::string_view`.  
  **Fix:** `lookup(keyView)` with transparent hashing/equality.  
  **Why:** keeps lookup path allocation-free.

## Migration guidance

- New APIs should follow these rules by default.
- Existing APIs can be migrated opportunistically when touched.
- For sink conversions (`std::string` by value -> `std::string&&`), update call sites to make move/copy intent explicit.
- Prefer small incremental changes over broad churn-only refactors.

## Team discussion prompts

- Should `std::string&&` sink style be mandatory in all native addon packages, or only performance-sensitive layers?
- Should we permit by-value sinks when call-site ergonomics are more important than strict intent enforcement?
- Do we want a lint/checklist item for explicit move/copy intent on sink calls?

## Compiler Explorer evidence (Clang 22, exceptions enabled)

The following samples use Clang 22 (`clang2210`) with `-O2 -std=c++20` and default exception support to mirror addon build conditions:

- C API boundary sample: [godbolt.org/z/ofe6Mbfcr](https://godbolt.org/z/ofe6Mbfcr)
- Read-only sample (`const std::string&` vs `std::string_view`): [godbolt.org/z/hfWhfq3q6](https://godbolt.org/z/hfWhfq3q6)
- Sink sample (`const std::string&` vs `std::string&&`): [godbolt.org/z/4xbfes9Md](https://godbolt.org/z/4xbfes9Md)

Key observations:

- In literal-to-`const std::string&` paths, generated code includes `operator new`, literal copy into heap storage, and `operator delete`.
- With exceptions enabled, those temporary-string paths also include unwind/cleanup code (`_Unwind_Resume`, personality references), increasing code size and control-flow complexity.
- Equivalent `const char*` and `std::string_view` paths pass pointer (and length for `string_view`) directly, avoiding temporary string construction.
- In sink code, the `const std::string&` assignment path is copy-oriented, while the `std::string&&` path follows move/transfer logic.

## References

- `packages/inference-addon-cpp/src/inference-addon-cpp/TransparentStringMap.hpp`
- [cppreference: `std::basic_string_view` (`std::string_view`)](https://en.cppreference.com/w/cpp/string/basic_string_view)
- [cppreference: rvalue references](https://en.cppreference.com/w/cpp/language/reference#Rvalue_references)
- [cppreference: `std::move`](https://en.cppreference.com/w/cpp/utility/move)
- [cppreference: `std::unordered_map`](https://en.cppreference.com/w/cpp/container/unordered_map)
- [cppreference: `std::unordered_map::find` (heterogeneous lookup overloads)](https://en.cppreference.com/w/cpp/container/unordered_map/find)
