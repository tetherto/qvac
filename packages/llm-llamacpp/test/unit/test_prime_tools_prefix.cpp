#include <algorithm>
#include <cctype>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <gtest/gtest.h>
#include <llama.h>

#include "prime_chat_templates.hpp"
#include "test_common.hpp"
#include "utils/ChatTemplateUtils.hpp"

using namespace qvac_lib_inference_addon_llama::utils;
namespace fixtures = qvac_lib_inference_addon_llama::test;

namespace {

// One token per byte, except that a run of newlines and a space followed by
// a letter each become a single token, as BPE merges them. That is what makes
// a cut right after `user\n` unsafe when the content starts with `\n`.
std::vector<llama_token> fakeTokenize(const std::string& text) {
  constexpr llama_token newlineRunBase = 1000;
  constexpr llama_token spaceLetterBase = 2000;
  std::vector<llama_token> tokens;
  for (size_t i = 0; i < text.size();) {
    const auto ch = static_cast<unsigned char>(text[i]);
    if (ch == '\n') {
      size_t end = i;
      while (end < text.size() && text[end] == '\n') {
        ++end;
      }
      tokens.push_back(newlineRunBase + static_cast<llama_token>(end - i));
      i = end;
    } else if (
        ch == ' ' && i + 1 < text.size() &&
        std::isalpha(static_cast<unsigned char>(text[i + 1])) != 0) {
      tokens.push_back(
          spaceLetterBase + static_cast<unsigned char>(text[i + 1]));
      i += 2;
    } else {
      tokens.push_back(static_cast<llama_token>(ch));
      ++i;
    }
  }
  return tokens;
}

const Tokenizer FAKE_TOKENIZER = fakeTokenize;

common_chat_tool makeWeatherTool() {
  common_chat_tool tool;
  tool.name = "get_weather";
  tool.description = "Get the weather for a city";
  tool.parameters =
      R"({"type":"object","properties":{"city":{"type":"string"}},)"
      R"("required":["city"]})";
  return tool;
}

common_chat_msg makeMessage(const std::string& role, const std::string& text) {
  common_chat_msg message;
  message.role = role;
  message.content = text;
  return message;
}

common_chat_templates_inputs makeSystemAndTools() {
  common_chat_templates_inputs inputs;
  inputs.use_jinja = true;
  inputs.enable_thinking = true;
  inputs.add_generation_prompt = false;
  inputs.messages = {makeMessage("system", "You are a weather assistant.")};
  inputs.tools = {makeWeatherTool()};
  return inputs;
}

common_chat_templates_inputs makeSystemOnly() {
  common_chat_templates_inputs inputs = makeSystemAndTools();
  inputs.tools.clear();
  return inputs;
}

// What a later request with the messages and tools of @p inputs renders.
std::string renderWithQuestion(
    const common_chat_templates* tmpls, const std::string& question,
    common_chat_templates_inputs inputs = makeSystemAndTools()) {
  inputs.messages.push_back(makeMessage("user", question));
  inputs.add_generation_prompt = true;
  return common_chat_templates_apply(tmpls, inputs).prompt;
}

bool isTokenPrefixOf(
    const std::string& prefix, const std::string& full,
    const Tokenizer& tokenize = FAKE_TOKENIZER) {
  const auto prefixTokens = tokenize(prefix);
  const auto fullTokens = tokenize(full);
  return prefixTokens.size() <= fullTokens.size() &&
         std::equal(
             prefixTokens.begin(), prefixTokens.end(), fullTokens.begin());
}

const std::vector<std::string> QUESTIONS{
    "What is the weather in Paris?",
    " leading space",
    "\nleading newline",
    "\n\nrepeated newlines",
    "\r\nleading CRLF",
    "\tleading tab",
    "123 numbers first",
    "?punctuation first",
    "¿Qué tiempo hace?",
    "日本の天気は？"};

} // namespace

TEST(PrimeToolsPrefixTest, Qwen38DropsToolsWithoutAUserTurn) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, fixtures::QWEN38_CHAT_TEMPLATE);
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeSystemAndTools();
  const PromptRenderResult plain = getPrompt(tmpls.get(), inputs);
  EXPECT_TRUE(plain.toolDefinitionsDropped)
      << "precondition: Qwen3.8 raises without a user turn: " << plain.prompt;
}

TEST(PrimeToolsPrefixTest, Qwen38CachesSystemAndToolsUpToTheUserContent) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, fixtures::QWEN38_CHAT_TEMPLATE);
  ASSERT_NE(tmpls, nullptr);

  const std::optional<PromptRenderResult> primed =
      renderWithoutUserTurn(tmpls.get(), makeSystemAndTools(), FAKE_TOKENIZER);
  ASSERT_TRUE(primed.has_value());

  EXPECT_NE(primed->prompt.find("get_weather"), std::string::npos)
      << primed->prompt;
  EXPECT_NE(
      primed->prompt.find("You are a weather assistant."), std::string::npos)
      << primed->prompt;
  EXPECT_EQ(primed->prompt.find("<|im_start|>assistant"), std::string::npos)
      << "no generation prompt: " << primed->prompt;
  EXPECT_TRUE(primed->generationPrompt.empty());
  EXPECT_FALSE(primed->toolDefinitionsDropped);
  EXPECT_TRUE(primed->renderedByJinja);

  for (const std::string& question : QUESTIONS) {
    const std::string full = renderWithQuestion(tmpls.get(), question);
    EXPECT_TRUE(isTokenPrefixOf(primed->prompt, full))
        << "question: " << question << "\nprimed: " << primed->prompt
        << "\nfull: " << full;
  }
}

// Without tools Qwen3.8 raises too, and `getPrompt` falls back to the legacy
// renderer, whose system block lacks the reasoning instructions the Jinja
// render puts there.
TEST(PrimeToolsPrefixTest, Qwen38SystemPromptAloneFallsBackToTheLegacyRender) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, fixtures::QWEN38_CHAT_TEMPLATE);
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeSystemOnly();
  const PromptRenderResult plain = getPrompt(tmpls.get(), inputs);
  EXPECT_FALSE(plain.renderedByJinja)
      << "precondition: Qwen3.8 raises without a user turn: " << plain.prompt;
  const std::string full =
      renderWithQuestion(tmpls.get(), QUESTIONS.front(), makeSystemOnly());
  EXPECT_FALSE(isTokenPrefixOf(plain.prompt, full))
      << "plain: " << plain.prompt << "\nfull: " << full;
}

TEST(PrimeToolsPrefixTest, Qwen38CachesASystemPromptAloneUpToTheUserContent) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, fixtures::QWEN38_CHAT_TEMPLATE);
  ASSERT_NE(tmpls, nullptr);

  const std::optional<PromptRenderResult> primed =
      renderWithoutUserTurn(tmpls.get(), makeSystemOnly(), FAKE_TOKENIZER);
  ASSERT_TRUE(primed.has_value());

  EXPECT_NE(
      primed->prompt.find("Reasoning effort is set to xhigh."),
      std::string::npos)
      << primed->prompt;
  EXPECT_NE(
      primed->prompt.find("You are a weather assistant."), std::string::npos)
      << primed->prompt;
  EXPECT_EQ(primed->prompt.find("<tools>"), std::string::npos)
      << primed->prompt;
  EXPECT_TRUE(primed->prompt.ends_with("<|im_start|>user\n")) << primed->prompt;
  EXPECT_TRUE(primed->generationPrompt.empty());
  EXPECT_FALSE(primed->toolDefinitionsDropped);
  EXPECT_TRUE(primed->renderedByJinja);

  for (const std::string& question : QUESTIONS) {
    const std::string full =
        renderWithQuestion(tmpls.get(), question, makeSystemOnly());
    EXPECT_TRUE(isTokenPrefixOf(primed->prompt, full))
        << "question: " << question << "\nprimed: " << primed->prompt
        << "\nfull: " << full;
  }
}

// GLM-5.3-Flash and DeepSeek V4 Flash render a system prompt, and its tools,
// without a user turn, so the request keeps the plain render, which is already
// a token prefix of the next request.
TEST(
    PrimeToolsPrefixTest, TemplatesThatRenderWithoutAUserTurnAreLeftAsTheyAre) {
  for (const char* source :
       {fixtures::GLM53_FLASH_CHAT_TEMPLATE,
        fixtures::DEEPSEEK_V4_FLASH_CHAT_TEMPLATE}) {
    common_chat_templates_ptr tmpls =
        common_chat_templates_init(nullptr, source);
    ASSERT_NE(tmpls, nullptr);

    for (const common_chat_templates_inputs& base :
         {makeSystemAndTools(), makeSystemOnly()}) {
      EXPECT_FALSE(
          renderWithoutUserTurn(tmpls.get(), base, FAKE_TOKENIZER).has_value());

      common_chat_templates_inputs inputs = base;
      const PromptRenderResult plain = getPrompt(tmpls.get(), inputs);
      EXPECT_TRUE(plain.renderedByJinja) << plain.prompt;
      EXPECT_FALSE(plain.toolDefinitionsDropped) << plain.prompt;
      EXPECT_EQ(
          plain.prompt.find("get_weather") != std::string::npos,
          !base.tools.empty())
          << plain.prompt;
      for (const std::string& question : QUESTIONS) {
        const std::string full =
            renderWithQuestion(tmpls.get(), question, base);
        EXPECT_TRUE(isTokenPrefixOf(plain.prompt, full))
            << "question: " << question << "\nplain: " << plain.prompt
            << "\nfull: " << full;
      }
    }
  }
}

TEST(PrimeToolsPrefixTest, ConversationWithAUserTurnIsNotTouched) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, fixtures::QWEN38_CHAT_TEMPLATE);
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeSystemAndTools();
  inputs.messages.push_back(makeMessage("user", "Hi"));
  EXPECT_FALSE(
      renderWithoutUserTurn(tmpls.get(), inputs, FAKE_TOKENIZER).has_value());
}

// A template that cannot render the conversation with a user message either
// leaves the request to `getPrompt`.
TEST(PrimeToolsPrefixTest, TemplateRejectingThePlaceholderIsLeftToGetPrompt) {
  constexpr const char* kNeedsThreeMessagesTemplate =
      "{%- if messages|length < 3 %}"
      "{{ raise_exception('needs a longer conversation') }}{%- endif %}"
      "{%- for m in messages %}<{{ m.role }}>{{ m.content }}{%- endfor %}";
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, kNeedsThreeMessagesTemplate);
  ASSERT_NE(tmpls, nullptr);

  for (const common_chat_templates_inputs& inputs :
       {makeSystemAndTools(), makeSystemOnly()}) {
    EXPECT_FALSE(
        renderWithoutUserTurn(tmpls.get(), inputs, FAKE_TOKENIZER).has_value());
  }
}

// Tools rendered after the user content leave no tools prefix to cache.
TEST(PrimeToolsPrefixTest, ToolsAfterTheUserContentAreRejected) {
  constexpr const char* kToolsAfterUserTemplate =
      "{%- set ns = namespace(user=false) %}"
      "{%- for m in messages %}<{{ m.role }}>{{ m.content }}"
      "{%- if m.role == 'user' %}{%- set ns.user = true %}{%- endif %}"
      "{%- endfor %}"
      "{%- if ns.user and tools %}"
      "{%- for t in tools %}<def>{{ t.function.name }}</def>{%- endfor %}"
      "{%- endif %}"
      "{%- if add_generation_prompt %}<assistant>{%- endif %}";
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, kToolsAfterUserTemplate);
  ASSERT_NE(tmpls, nullptr);

  EXPECT_FALSE(
      renderWithoutUserTurn(tmpls.get(), makeSystemAndTools(), FAKE_TOKENIZER)
          .has_value());
}

TEST(PrimeToolsPrefixTest, RequiredToolsAfterTheUserContentAreRejected) {
  constexpr const char* source =
      "{%- if not tools and messages[0].content == 'You are a weather "
      "assistant.' %}"
      "{{ raise_exception('tools required') }}{%- endif %}"
      "{%- set ns = namespace(user=false) %}"
      "{%- for m in messages %}"
      "{%- if m.role == 'user' %}{%- set ns.user = true %}{%- endif %}"
      "{%- endfor %}{%- if not ns.user %}"
      "{{ raise_exception('user required') }}{%- endif %}"
      "{%- for m in messages %}<{{ m.role }}>{{ m.content }}{%- endfor %}"
      "{%- for t in tools %}<def>{{ t.function.name }}</def>{%- endfor %}";
  auto tmpls = common_chat_templates_init(nullptr, source);
  ASSERT_NE(tmpls, nullptr);
  EXPECT_FALSE(
      renderWithoutUserTurn(tmpls.get(), makeSystemAndTools(), FAKE_TOKENIZER)
          .has_value());
}

TEST(PrimeToolsPrefixTest, ToolBoilerplateDoesNotProveTheDefinitionsAreCached) {
  constexpr const char* source =
      "{%- set ns = namespace(user=false) %}"
      "{%- for m in messages %}"
      "{%- if m.role == 'user' %}{%- set ns.user = true %}{%- endif %}"
      "{%- endfor %}{%- if not ns.user %}"
      "{{ raise_exception('user required') }}{%- endif %}"
      "{%- if tools %}<tool-mode>on</tool-mode>{%- endif %}"
      "{%- for m in messages %}<{{ m.role }}>{{ m.content }}{%- endfor %}"
      "{%- for t in tools %}<def>{{ t.function.name }}</def>{%- endfor %}";
  auto tmpls = common_chat_templates_init(nullptr, source);
  ASSERT_NE(tmpls, nullptr);
  EXPECT_FALSE(
      renderWithoutUserTurn(tmpls.get(), makeSystemAndTools(), FAKE_TOKENIZER)
          .has_value());
}

TEST(PrimeToolsPrefixTest, TokenBackoffCannotDiscardTheToolBlock) {
  constexpr const char* source =
      "{%- set ns = namespace(user=false) %}"
      "{%- for m in messages %}"
      "{%- if m.role == 'user' %}{%- set ns.user = true %}{%- endif %}"
      "{%- endfor %}{%- if not ns.user %}"
      "{{ raise_exception('user required') }}{%- endif %}"
      "prefix"
      "{%- if tools %}<tools>"
      "{%- for t in tools %}{{ t.function.name }}{%- endfor %}"
      "</tools>{%- endif %}"
      "{%- for m in messages %}<{{ m.role }}>{{ m.content }}{%- endfor %}";
  auto tmpls = common_chat_templates_init(nullptr, source);
  ASSERT_NE(tmpls, nullptr);
  const Tokenizer mergeToolTail = [](const std::string& text) {
    const size_t start = text.find("<tools>");
    if (start == std::string::npos) {
      return fakeTokenize(text);
    }
    auto tokens = fakeTokenize(text.substr(0, start));
    tokens.push_back(10000 + static_cast<llama_token>(text.size()));
    return tokens;
  };
  EXPECT_FALSE(
      renderWithoutUserTurn(tmpls.get(), makeSystemAndTools(), mergeToolTail)
          .has_value());
}

TEST(PrimeToolsPrefixTest, RealVocabularyKeepsThePrimedTokensForEveryQuestion) {
  const test_common::TestModelPath modelPath(
      "Qwen3.5-0.8B-Q8_0.gguf",
      "QWEN35_MODEL_PATH",
      test_common::TestModelPath::OnMissing::Fail);
  ASSERT_TRUE(modelPath.found()) << modelPath.missingMessage();
  auto params = llama_model_default_params();
  params.vocab_only = true;
  params.n_gpu_layers = 0;
  std::unique_ptr<llama_model, decltype(&llama_model_free)> model(
      llama_model_load_from_file(modelPath.path.c_str(), params),
      llama_model_free);
  ASSERT_NE(model, nullptr);
  const Tokenizer tokenize = [&model](const std::string& text) {
    return common_tokenize(
        llama_model_get_vocab(model.get()), text, false, true);
  };
  const char* modelTemplate = llama_model_chat_template(model.get(), nullptr);
  ASSERT_NE(modelTemplate, nullptr);
  const char* sources[]{modelTemplate, fixtures::QWEN38_CHAT_TEMPLATE};
  for (const char* source : sources) {
    auto tmpls = common_chat_templates_init(nullptr, source);
    ASSERT_NE(tmpls, nullptr);
    for (bool thinking : {false, true}) {
      for (auto inputs : {makeSystemAndTools(), makeSystemOnly()}) {
        inputs.enable_thinking = thinking;
        auto primed = renderWithoutUserTurn(tmpls.get(), inputs, tokenize);
        auto rendered = primed.has_value() ? std::move(*primed)
                                           : getPrompt(tmpls.get(), inputs);
        ASSERT_FALSE(rendered.prompt.empty());
        EXPECT_FALSE(rendered.toolDefinitionsDropped);
        for (const std::string& question : QUESTIONS) {
          EXPECT_TRUE(isTokenPrefixOf(
              rendered.prompt,
              renderWithQuestion(tmpls.get(), question, inputs),
              tokenize))
              << "question: " << question << "\nprimed: " << rendered.prompt;
        }
      }
    }
  }
}

// Content is not trimmed, so a question starting with a newline merges with
// the newline after the role header; the cut must stop before that newline.
TEST(PrimeToolsPrefixTest, CutBacksOffToATokenBoundary) {
  constexpr const char* kUserGuardedToolsTemplate =
      "{%- set ns = namespace(user=false) %}"
      "{%- for m in messages %}"
      "{%- if m.role == 'user' %}{%- set ns.user = true %}{%- endif %}"
      "{%- endfor %}"
      "{%- if not ns.user %}{{ raise_exception('No user query found') }}"
      "{%- endif %}"
      "{%- if tools %}<tools>"
      "{%- for t in tools %}{{ t.function.name }}{%- endfor %}"
      "</tools>{%- endif %}"
      "{%- for m in messages %}<{{ m.role }}>\n{{ m.content }}{%- endfor %}"
      "{%- if add_generation_prompt %}<assistant>\n{%- endif %}";
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, kUserGuardedToolsTemplate);
  ASSERT_NE(tmpls, nullptr);

  const std::optional<PromptRenderResult> primed =
      renderWithoutUserTurn(tmpls.get(), makeSystemAndTools(), FAKE_TOKENIZER);
  ASSERT_TRUE(primed.has_value());
  EXPECT_EQ(
      primed->prompt,
      "<tools>get_weather</tools><system>\nYou are a weather assistant.<user>");
  for (const std::string& question : QUESTIONS) {
    const std::string full = renderWithQuestion(tmpls.get(), question);
    EXPECT_TRUE(isTokenPrefixOf(primed->prompt, full))
        << "question: " << question << "\nprimed: " << primed->prompt
        << "\nfull: " << full;
  }
}

TEST(PrimeToolsPrefixTest, HasUserTurnCountsUserAndToolRoles) {
  EXPECT_FALSE(hasUserTurn({makeMessage("system", "s")}));
  EXPECT_TRUE(
      hasUserTurn({makeMessage("system", "s"), makeMessage("user", "u")}));
  EXPECT_TRUE(hasUserTurn({makeMessage("tool", "r")}));
}
