// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  isAddonContextOverflowError,
  parseContextOverflowMessage,
} from "@/server/bare/plugins/llamacpp-completion/ops/context-overflow";

// The addon's structured-code format from
// `qvac_errors::StatusError::codeString()`:
// `"[ <addonId> :: <localCodeMsg> ]"`. Bare's `js_throw_error(env,
// code, msg)` sets this string on the JS Error's `.code`.
const ADDON_CODE = "[ TextLlmAddon :: ContextOverflow ]";

test("isAddonContextOverflowError: detects addon's structured codeString", (t) => {
  const err = Object.assign(new Error("anything"), { code: ADDON_CODE });
  t.is(isAddonContextOverflowError(err), true);
});

test("isAddonContextOverflowError: detects message-only fallback path", (t) => {
  // `LlamaModel::processPromptImpl` emits `"<func>: context overflow\n"`
  // with neither a structured code on the Error nor numbers in the
  // message. The detector must still fire on the message substring so
  // the consumer gets a typed error instead of a generic
  // `CompletionFailedError`.
  const bareForm = new Error("processPromptImpl: context overflow\n");
  t.is(isAddonContextOverflowError(bareForm), true);
});

test("isAddonContextOverflowError: ignores unrelated errors", (t) => {
  t.is(isAddonContextOverflowError(new Error("model failed to load")), false);
  t.is(
    isAddonContextOverflowError(
      Object.assign(new Error("x"), { code: "[ TtsAddon :: InternalError ]" }),
    ),
    false,
  );
  t.is(isAddonContextOverflowError(null), false);
  t.is(isAddonContextOverflowError(undefined), false);
  t.is(isAddonContextOverflowError("a string"), false);
  t.is(isAddonContextOverflowError(42), false);
});

test("isAddonContextOverflowError: codeString anchored — sibling names don't match", (t) => {
  // The detector should fire ONLY when the codeString ends in
  // `:: ContextOverflow ]` — a future addon-side rename like
  // `ContextOverflowRecovered` or `PostContextOverflow` must not
  // silently route here.
  t.is(
    isAddonContextOverflowError(
      Object.assign(new Error("x"), { code: "[ TextLlmAddon :: ContextOverflowRecovered ]" }),
    ),
    false,
  );
  t.is(
    isAddonContextOverflowError(
      Object.assign(new Error("x"), { code: "[ TextLlmAddon :: PostContextOverflow ]" }),
    ),
    false,
  );
  // The exact form still matches.
  t.is(
    isAddonContextOverflowError(
      Object.assign(new Error("x"), { code: "[ TextLlmAddon :: ContextOverflow ]" }),
    ),
    true,
  );
});

test("isAddonContextOverflowError: message fallback is anchored to known C++ formats", (t) => {
  // Permissive matching on `/context overflow/i` would fire on
  // wrapper / log lines like "recovering from context overflow"
  // — anchor to the two literal C++ emitted strings.
  t.is(
    isAddonContextOverflowError(new Error("recovering from context overflow upstream")),
    false,
  );
  t.is(
    isAddonContextOverflowError(new Error("context overflow at prefill step (5 tokens, max 4)")),
    true,
  );
  t.is(
    isAddonContextOverflowError(new Error("processPromptImpl: context overflow\n")),
    true,
  );
});

test("parseContextOverflowMessage: extracts from long-form TextLlm message", (t) => {
  // The long form comes from
  // `TextLlmContext.cpp` when it formats both numbers explicitly:
  // `"[TextLlm] context overflow at prefill step: prompt tokens N,
  //   max context tokens M\n"`.
  const msg =
    "[TextLlm] context overflow at prefill step: prompt tokens 5432, max context tokens 4096\n";
  t.alike(parseContextOverflowMessage(msg), {
    promptTokens: 5432,
    ctxSize: 4096,
  });
});

test("parseContextOverflowMessage: extracts from short-form bracketed message", (t) => {
  // The short form is used by both `TextLlmContext.cpp` (the second
  // overflow site) and `MtmdLlmContext.cpp`:
  // `"... at prefill step (N tokens, max M)\n"`.
  const text = "[TextLlm] context overflow at prefill step (8192 tokens, max 4096)\n";
  t.alike(parseContextOverflowMessage(text), {
    promptTokens: 8192,
    ctxSize: 4096,
  });

  const mtmd = "[MtmdLlm] context overflow at prefill step (1024 tokens, max 512)\n";
  t.alike(parseContextOverflowMessage(mtmd), {
    promptTokens: 1024,
    ctxSize: 512,
  });
});

test("parseContextOverflowMessage: empty result when numbers are absent", (t) => {
  // `LlamaModel::processPromptImpl` emits a bare message with no
  // numbers — both fields stay undefined so `ContextOverflowError`
  // can fall through to the message-only constructor path.
  t.alike(
    parseContextOverflowMessage("processPromptImpl: context overflow\n"),
    {},
  );
  t.alike(parseContextOverflowMessage(""), {});
});
