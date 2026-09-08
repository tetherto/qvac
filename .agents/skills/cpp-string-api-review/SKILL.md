---
name: cpp-string-api-review
description: Review C++ changes for string parameter and call-site efficiency conventions (`std::string_view`, `std::string&&`, `const std::string&`, `const char*`, and TransparentStringMap lookup). Use when reviewing C++ code, refactoring addon interfaces, or invoking /cpp-string-api-review.
disable-model-invocation: true
---

# C++ String API Review

Review C++ code for string API convention compliance and produce actionable fixes.

## When to use this skill

**Use when:**

- User asks for a review of C++ string parameter choices.
- User asks to migrate existing code toward string API conventions.
- User invokes `/cpp-string-api-review`.

**Do NOT use for:**

- Non-C++ changes.
- Broad performance review unrelated to string interfaces.

## Scope and source of truth

- Primary reference: `docs/conventions/string-api-conventions.md`
- Supporting implementation reference: `packages/inference-addon-cpp/src/inference-addon-cpp/TransparentStringMap.hpp`

## Review workflow

1. Identify touched C++ files (`*.h`, `*.hpp`, `*.cc`, `*.cpp`, `*.cxx`) in scope.
2. Inspect string parameters and classify each as:
   - read-only non-owning (`std::string_view`),
   - sink ownership transfer (`std::string&&`),
   - downstream compatibility (`const std::string&`),
   - C boundary (`const char*`).
3. Flag cost/correctness issues:
   - read-only `const std::string&` where `std::string_view` is sufficient,
   - sink modeled as `const std::string&` + copy instead of `std::string&&` + move,
   - hidden temporary conversions (`std::string{view}`) on hot paths,
   - unsafe `view.data()` usage where null termination is not guaranteed,
   - avoidable temporary key materialization in map lookups.
4. Check for requirement propagation ("requirements bubble up"):
   - if a wrapper takes `std::string_view` but must call a `const std::string&` API, surface the trade-off and propose the correct boundary.
5. Produce findings grouped by severity:
   - High: correctness/lifetime/null-termination issues,
   - Medium: hidden alloc/copy churn in common paths,
   - Low: style/consistency improvements.
6. Propose precise edits with before/after snippets. Only apply code changes after explicit user confirmation.

## Output format

Use this structure:

```markdown
## C++ String API Review

### Findings
- [High|Medium|Low] <short title> — <file/symbol>
  - Why it matters: <cost/correctness impact>
  - Suggested change: <concise fix>

### Recommended edits
1. <edit 1>
2. <edit 2>

### Notes
- <boundary trade-offs, if any>
```

## Quick heuristics

- Prefer explicit ownership intent over hidden conversions.
- Prefer leaf-first migration to `std::string_view` through call chains.
- If downstream requires `const std::string&`, do not hide that cost behind wrapper layers.

