#pragma once

#include <array>
#include <string>

#include <common/chat.h>

#include "prime_chat_templates.hpp"
#include "qwen3_chat_template.hpp"
#include "utils/ChatTemplateUtils.hpp"

namespace qvac_lib_inference_addon_llama::test {

// GLM and DeepSeek chat templates, copied verbatim from qvac-fabric-llm.cpp
// `models/templates/` at v11739.1.1 (trailing newline dropped). Each comment
// gives the generation prompt it renders with thinking on.

// GLM-4.6: `<|assistant|>` only; the model opens its own `<think>`.
inline constexpr const char* GLM46_CHAT_TEMPLATE = R"jinja([gMASK]<sop>
{%- if tools -%}
<|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{% for tool in tools %}
{{ tool | tojson(ensure_ascii=False) }}
{% endfor %}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
<arg_key>{arg-key-2}</arg_key>
<arg_value>{arg-value-2}</arg_value>
...
</tool_call>{%- endif -%}
{%- macro visible_text(content) -%}
    {%- if content is string -%}
        {{- content }}
    {%- elif content is iterable and content is not mapping -%}
        {%- for item in content -%}
            {%- if item is mapping and item.type == 'text' -%}
                {{- item.text }}
            {%- elif item is string -%}
                {{- item }}
            {%- endif -%}
        {%- endfor -%}
    {%- else -%}
        {{- content }}
    {%- endif -%}
{%- endmacro -%}
{%- set ns = namespace(last_user_index=-1) %}
{%- for m in messages %}
    {%- if m.role == 'user' %}
        {% set ns.last_user_index = loop.index0 -%}
    {%- endif %}
{%- endfor %}
{% for m in messages %}
{%- if m.role == 'user' -%}<|user|>
{{ visible_text(m.content) }}
{{- '/nothink' if (enable_thinking is defined and not enable_thinking and not visible_text(m.content).endswith("/nothink")) else '' -}}
{%- elif m.role == 'assistant' -%}
<|assistant|>
{%- set reasoning_content = '' %}
{%- set content = visible_text(m.content) %}
{%- if m.reasoning_content is string %}
    {%- set reasoning_content = m.reasoning_content %}
{%- else %}
    {%- if '</think>' in content %}
        {%- set reasoning_content = content.split('</think>')[0].rstrip('\n').split('<think>')[-1].lstrip('\n') %}
        {%- set content = content.split('</think>')[-1].lstrip('\n') %}
    {%- endif %}
{%- endif %}
{%- if loop.index0 > ns.last_user_index and reasoning_content -%}
{{ '\n<think>' + reasoning_content.strip() +  '</think>'}}
{%- else -%}
{{ '\n<think></think>' }}
{%- endif -%}
{%- if content.strip() -%}
{{ '\n' + content.strip() }}
{%- endif -%}
{% if m.tool_calls %}
{% for tc in m.tool_calls %}
{%- if tc.function %}
    {%- set tc = tc.function %}
{%- endif %}
{{ '\n<tool_call>' + tc.name }}
{% set _args = tc.arguments or {} %}
{% if _args is not mapping %}
    {{ raise_exception("Invalid tool call arguments passed: " + _args | string) }}
{% endif %}
{% for k, v in _args.items() %}
<arg_key>{{ k }}</arg_key>
<arg_value>{{ v | tojson(ensure_ascii=False) if v is not string else v }}</arg_value>
{% endfor %}
</tool_call>{% endfor %}
{% endif %}
{%- elif m.role == 'tool' -%}
{%- if m.content is string -%}
{%- if loop.first or (messages[loop.index0 - 1].role != "tool") %}
    {{- '<|observation|>' }}
{%- endif %}
{{- '\n<tool_response>\n' }}
{{- m.content }}
{{- '\n</tool_response>' }}
{%- else -%}
<|observation|>{% for tr in m.content %}

<tool_response>
{{ tr.output if tr.output is defined else tr }}
</tool_response>{% endfor -%}
{% endif -%}
{%- elif m.role == 'system' -%}
<|system|>
{{ visible_text(m.content) }}
{%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt -%}
    <|assistant|>{{- '\n<think></think>' if (enable_thinking is defined and not enable_thinking) else '' -}}
{%- endif -%})jinja";

// GLM-4.7-Flash: `<|assistant|><think>`.
inline constexpr const char* GLM47_FLASH_CHAT_TEMPLATE = R"jinja([gMASK]<sop>
{%- if tools -%}
<|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{% for tool in tools %}
{{ tool | tojson(ensure_ascii=False) }}
{% endfor %}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}<arg_key>{arg-key-1}</arg_key><arg_value>{arg-value-1}</arg_value><arg_key>{arg-key-2}</arg_key><arg_value>{arg-value-2}</arg_value>...</tool_call>{%- endif -%}
{%- macro visible_text(content) -%}
    {%- if content is string -%}
        {{- content }}
    {%- elif content is iterable and content is not mapping -%}
        {%- for item in content -%}
            {%- if item is mapping and item.type == 'text' -%}
                {{- item.text }}
            {%- elif item is string -%}
                {{- item }}
            {%- endif -%}
        {%- endfor -%}
    {%- else -%}
        {{- content }}
    {%- endif -%}
{%- endmacro -%}
{%- set ns = namespace(last_user_index=-1) %}
{%- for m in messages %}
    {%- if m.role == 'user' %}
        {% set ns.last_user_index = loop.index0 -%}
    {%- endif %}
{%- endfor %}
{% for m in messages %}
{%- if m.role == 'user' -%}<|user|>{{ visible_text(m.content) }}
{%- elif m.role == 'assistant' -%}
<|assistant|>
{%- set reasoning_content = '' %}
{%- set content = visible_text(m.content) %}
{%- if m.reasoning_content is string %}
    {%- set reasoning_content = m.reasoning_content %}
{%- else %}
    {%- if '</think>' in content %}
        {%- set reasoning_content = content.split('</think>')[0].rstrip('\n').split('<think>')[-1].lstrip('\n') %}
        {%- set content = content.split('</think>')[-1].lstrip('\n') %}
    {%- endif %}
{%- endif %}
{%- if ((clear_thinking is defined and not clear_thinking) or loop.index0 > ns.last_user_index) and reasoning_content -%}
{{ '<think>' + reasoning_content.strip() +  '</think>'}}
{%- else -%}
{{ '</think>' }}
{%- endif -%}
{%- if content.strip() -%}
{{ content.strip() }}
{%- endif -%}
{% if m.tool_calls %}
{% for tc in m.tool_calls %}
{%- if tc.function %}
    {%- set tc = tc.function %}
{%- endif %}
{{- '<tool_call>' + tc.name -}}
{% set _args = tc.arguments %}{% for k, v in _args.items() %}<arg_key>{{ k }}</arg_key><arg_value>{{ v | tojson(ensure_ascii=False) if v is not string else v }}</arg_value>{% endfor %}</tool_call>{% endfor %}
{% endif %}
{%- elif m.role == 'tool' -%}
{%- if m.content is string -%}
{%- if loop.first or (messages[loop.index0 - 1].role != "tool") %}
    {{- '<|observation|>' }}
{%- endif %}
{{- '<tool_response>' }}
{{- m.content }}
{{- '</tool_response>' }}
{%- else -%}
<|observation|>{% for tr in m.content %}
<tool_response>{{ tr.output if tr.output is defined else tr }}</tool_response>{% endfor -%}
{% endif -%}
{%- elif m.role == 'system' -%}
<|system|>{{ visible_text(m.content) }}
{%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt -%}
    <|assistant|>{{- '</think>' if (enable_thinking is defined and not enable_thinking) else '<think>' -}}
{%- endif -%})jinja";

// DeepSeek-R1-Distill-Qwen-32B: `<｜Assistant｜><think>\n`.
inline constexpr const char* DEEPSEEK_R1_DISTILL_QWEN_CHAT_TEMPLATE =
    R"jinja({% if not add_generation_prompt is defined -%}
  {%- set add_generation_prompt = false -%}
{%- endif -%}
{%- set ns = namespace(is_first=false, is_tool=false, is_output_first=true, system_prompt='') -%}
{%- for message in messages -%}
  {%- if message['role'] == 'system' -%}
    {%- set ns.system_prompt = message['content'] -%}
  {%- endif -%}
{%- endfor -%}{{bos_token}}{{ns.system_prompt}}
{%- for message in messages -%}
  {%- if message['role'] == 'user' -%}
    {%- set ns.is_tool = false -%}{{'<｜User｜>' + message['content']}}
  {%- endif -%}
  {%- if message['role'] == 'assistant' and message['tool_calls'] -%}
    {%- set ns.is_tool = false -%}
    {%- for tool in message['tool_calls']-%}
      {%- if not ns.is_first -%}
        {{'<｜Assistant｜><｜tool▁calls▁begin｜><｜tool▁call▁begin｜>' + tool['type'] + '<｜tool▁sep｜>' + tool['function']['name'] + '\n' + '```json' + '\n' + tool['function']['arguments'] | tojson + '\n' + '```' + '<｜tool▁call▁end｜>'}}
        {%- set ns.is_first = true -%}
      {%- else -%}
        {{'\n' + '<｜tool▁call▁begin｜>' + tool['type'] + '<｜tool▁sep｜>' + tool['function']['name'] + '\n' + '```json' + '\n' + tool['function']['arguments'] | tojson + '\n' + '```' + '<｜tool▁call▁end｜>'}}
      {%- endif -%}
    {%- endfor -%}
    {{'<｜tool▁calls▁end｜><｜end▁of▁sentence｜>'}}
  {%- endif -%}
  {%- if message['role'] == 'assistant' and message['content'] is not none -%}
    {%- if ns.is_tool -%}{{'<｜tool▁outputs▁end｜>' + message['content'] + '<｜end▁of▁sentence｜>'}}
      {%- set ns.is_tool = false -%}
    {%- else -%}
      {%- set content = message['content'] -%}
      {%- if '</think>' in content -%}
        {%- set content = content.split('</think>')[-1] -%}
      {%- endif -%}{{'<｜Assistant｜>' + content + '<｜end▁of▁sentence｜>'}}
    {%- endif -%}
  {%- endif -%}
  {%- if message['role'] == 'tool' -%}
    {%- set ns.is_tool = true -%}
    {%- if ns.is_output_first -%}{{'<｜tool▁outputs▁begin｜><｜tool▁output▁begin｜>' + message['content'] + '<｜tool▁output▁end｜>'}}
      {%- set ns.is_output_first = false -%}
      {%- else -%}{{'\n<｜tool▁output▁begin｜>' + message['content'] + '<｜tool▁output▁end｜>'}}
    {%- endif -%}
  {%- endif -%}
{%- endfor -%}
{%- if ns.is_tool -%}{{'<｜tool▁outputs▁end｜>'}}
{%- endif -%}
{%- if add_generation_prompt and not ns.is_tool -%}{{'<｜Assistant｜><think>\n'}}{% if not enable_thinking %}{{- '</think>' -}}{% endif %}
{%- endif %})jinja";

// DeepSeek-V3.1: `<｜Assistant｜><think>`.
inline constexpr const char* DEEPSEEK_V31_CHAT_TEMPLATE =
    R"jinja({% if not add_generation_prompt is defined -%}
  {%- set add_generation_prompt = false -%}
{%- endif -%}
{%- if not thinking is defined -%}
  {%- if enable_thinking is defined -%}
    {%- set thinking = enable_thinking -%}
    {%- else -%}
    {%- set thinking = false -%}
  {%- endif -%}
{%- endif -%}
{%- set ns = namespace(is_first=false, is_tool=false, system_prompt='', is_first_sp=true, is_last_user=false) -%}
{%- for message in messages -%}
  {%- if message['role'] == 'system' -%}
    {%- if ns.is_first_sp -%}
      {%- set ns.system_prompt = ns.system_prompt + message['content'] -%}
      {%- set ns.is_first_sp = false -%}
      {%- else -%}
      {%- set ns.system_prompt = ns.system_prompt + '

' + message['content'] -%}
    {%- endif -%}
  {%- endif -%}
{%- endfor -%}{{ bos_token }}{{ ns.system_prompt }}
{%- for message in messages -%}
  {%- if message['role'] == 'user' -%}
    {%- set ns.is_tool = false -%}
    {%- set ns.is_first = false -%}
    {%- set ns.is_last_user = true -%}{{'<｜User｜>' + message['content']}}
  {%- endif -%}
  {%- if message['role'] == 'assistant' and message['tool_calls'] -%}
    {%- if ns.is_last_user -%}{{'<｜Assistant｜><think></think>'}}
    {%- endif -%}
    {%- set ns.is_last_user = false -%}
    {%- set ns.is_first = false -%}
    {%- set ns.is_tool = false -%}
    {%- for tool in message['tool_calls'] -%}
      {%- if not ns.is_first -%}
        {%- if not message['content'] -%}{{'<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>'+ tool['function']['name'] + '<｜tool▁sep｜>' + tool['function']['arguments'] | tojson + '<｜tool▁call▁end｜>'}}
          {%- else -%}{{message['content'] + '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>' + tool['function']['name'] + '<｜tool▁sep｜>' + tool['function']['arguments'] | tojson + '<｜tool▁call▁end｜>'}}
        {%- endif -%}
        {%- set ns.is_first = true -%}
        {%- else -%}{{'<｜tool▁call▁begin｜>'+ tool['function']['name'] + '<｜tool▁sep｜>' + tool['function']['arguments'] | tojson + '<｜tool▁call▁end｜>'}}
      {%- endif -%}
    {%- endfor -%}{{'<｜tool▁calls▁end｜><｜end▁of▁sentence｜>'}}
  {%- endif -%}
  {%- if message['role'] == 'assistant' and not message['tool_calls'] -%}
    {%- if ns.is_last_user -%}{{'<｜Assistant｜>'}}
      {%- if message['prefix'] is defined and message['prefix'] and thinking -%}{{'<think>'}}
        {%- else -%}{{'<think></think>'}}
      {%- endif -%}
    {%- endif -%}
    {%- set ns.is_last_user = false -%}
    {%- if ns.is_tool -%}{{message['content'] + '<｜end▁of▁sentence｜>'}}
      {%- set ns.is_tool = false -%}
      {%- else -%}
      {%- set content = message['content'] -%}
      {%- if '</think>' in content -%}
        {%- set content = content.split('</think>', 1)[1] -%}
      {%- endif -%}{{content + '<｜end▁of▁sentence｜>'}}
    {%- endif -%}
  {%- endif -%}
  {%- if message['role'] == 'tool' -%}
    {%- set ns.is_last_user = false -%}
    {%- set ns.is_tool = true -%}{{'<｜tool▁output▁begin｜>' + message['content'] + '<｜tool▁output▁end｜>'}}
  {%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt and ns.is_last_user and not ns.is_tool -%}{{'<｜Assistant｜>'}}
  {%- if not thinking -%}{{'<think></think>'}}
  {%- else -%}{{'<think>'}}
  {%- endif -%}
{%- endif %})jinja";

// DeepSeek-V3.2: `<｜Assistant｜><think>`.
inline constexpr const char* DEEPSEEK_V32_CHAT_TEMPLATE =
    R"jinja({%- if not add_generation_prompt is defined -%}
  {%- set add_generation_prompt = false -%}
{%- endif -%}
{%- if not thinking is defined -%}
  {%- if enable_thinking is defined -%}
    {%- set thinking = enable_thinking -%}
  {%- else -%}
    {%- set thinking = false -%}
  {%- endif -%}
{%- endif -%}
{%- set dsml_token = '｜DSML｜' -%}
{%- set thinking_start_token = '<think>' -%}
{%- set thinking_end_token = '</think>' -%}
{%- set tools_header = '## Tools\n\nYou have access to a set of tools you can use to answer the user\'s question.\nYou can invoke functions by writing a "<' + dsml_token + 'function_calls>" block like the following as part of your reply to the user:\n<' + dsml_token + 'function_calls>\n<' + dsml_token + 'invoke name="$FUNCTION_NAME">\n<' + dsml_token + 'parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</' + dsml_token + 'parameter>\n...\n</' + dsml_token + 'invoke>\n<' + dsml_token + 'invoke name="$FUNCTION_NAME2">\n...\n</' + dsml_token + 'invoke>\n</' + dsml_token + 'function_calls>\n\nString and scalar parameters should be specified as is without any escaping or quotes, while lists and objects should use JSON format. The "string" attribute should be set to "true" for string type parameters and "false" for other types (numbers, booleans, arrays, objects).\n\nIf the thinking_mode is enabled, then after function results you should strongly consider outputting a thinking block. Here is an example:\n\n<' + dsml_token + 'function_calls>\n...\n</' + dsml_token + 'function_calls>\n\n<function_results>\n...\n</function_results>\n\n' + thinking_start_token + '...thinking about results' + thinking_end_token + '\n\nHere are the functions available in JSONSchema format:\n<functions>\n' -%}
{%- set tools_footer = '</functions>\n' -%}
{%- set ns = namespace(system_prompt='', is_first_sp=true) -%}
{%- for message in messages -%}
  {%- if message['role'] == 'system' -%}
    {%- if ns.is_first_sp -%}
      {%- set ns.system_prompt = ns.system_prompt + (message['content'] or '') -%}
      {%- set ns.is_first_sp = false -%}
    {%- else -%}
      {%- set ns.system_prompt = ns.system_prompt + '\n\n' + (message['content'] or '') -%}
    {%- endif -%}
  {%- endif -%}
{%- endfor -%}
{%- if tools is defined and tools -%}
  {%- set ts = namespace(schemas='') -%}
  {%- for tool in tools -%}
    {%- if tool['type'] == 'function' -%}
      {%- set ts.schemas = ts.schemas + (tool['function'] | tojson) + '\n' -%}
    {%- endif -%}
  {%- endfor -%}
  {%- if ns.system_prompt -%}
    {%- set ns.system_prompt = ns.system_prompt + '\n\n' + tools_header + ts.schemas + tools_footer -%}
  {%- else -%}
    {%- set ns.system_prompt = tools_header + ts.schemas + tools_footer -%}
  {%- endif -%}
{%- endif -%}
{{- bos_token -}}
{{- ns.system_prompt -}}
{%- set last_user_idx = namespace(value=-1) -%}
{%- for message in messages -%}
  {%- if message['role'] == 'user' or message['role'] == 'developer' -%}
    {%- set last_user_idx.value = loop.index0 -%}
  {%- endif -%}
{%- endfor -%}
{%- set state = namespace(pending_asst_marker=false, pending_tool_marker=false) -%}
{%- for message in messages -%}
  {%- if message['role'] == 'user' -%}
    {{- '<｜User｜>' + (message['content'] or '') -}}
    {%- set state.pending_asst_marker = true -%}
    {%- set state.pending_tool_marker = false -%}
  {%- elif message['role'] == 'assistant' -%}
    {%- set is_after_last_user = loop.index0 > last_user_idx.value -%}
    {%- if state.pending_asst_marker -%}
      {{- '<｜Assistant｜>' -}}
      {%- if is_after_last_user and thinking -%}
        {{- thinking_start_token -}}
        {%- if message['reasoning_content'] is defined and message['reasoning_content'] -%}
          {{- message['reasoning_content'] -}}
        {%- endif -%}
        {{- thinking_end_token -}}
      {%- else -%}
        {{- thinking_end_token -}}
      {%- endif -%}
    {%- elif state.pending_tool_marker -%}
      {%- if is_after_last_user and thinking -%}
        {{- '\n\n' + thinking_start_token -}}
        {%- if message['reasoning_content'] is defined and message['reasoning_content'] -%}
          {{- message['reasoning_content'] -}}
        {%- endif -%}
        {{- thinking_end_token -}}
      {%- else -%}
        {{- '\n\n' + thinking_end_token -}}
      {%- endif -%}
    {%- endif -%}
    {%- set state.pending_asst_marker = false -%}
    {%- set state.pending_tool_marker = false -%}
    {%- if message['content'] is defined and message['content'] -%}
      {{- message['content'] -}}
    {%- endif -%}
    {%- if message['tool_calls'] -%}
      {{- '\n\n<' + dsml_token + 'function_calls>\n' -}}
      {%- for tool in message['tool_calls'] -%}
        {%- set func = tool['function'] -%}
        {{- '<' + dsml_token + 'invoke name="' + func['name'] + '">\n' -}}
        {%- set args = func['arguments'] -%}
        {%- if args is string -%}
          {%- set args = args | from_json -%}
        {%- endif -%}
        {%- for key, val in args.items() -%}
          {%- if val is string -%}
            {{- '<' + dsml_token + 'parameter name="' + key + '" string="true">' + val + '</' + dsml_token + 'parameter>\n' -}}
          {%- else -%}
            {{- '<' + dsml_token + 'parameter name="' + key + '" string="false">' + (val | tojson) + '</' + dsml_token + 'parameter>\n' -}}
          {%- endif -%}
        {%- endfor -%}
        {{- '</' + dsml_token + 'invoke>\n' -}}
      {%- endfor -%}
      {{- '</' + dsml_token + 'function_calls>' -}}
    {%- endif -%}
    {{- '<｜end▁of▁sentence｜>' -}}
  {%- elif message['role'] == 'tool' -%}
    {%- set outer_index = loop.index0 -%}
    {%- set assistant_idx = namespace(value=-1) -%}
    {%- for prev_msg in messages -%}
      {%- if prev_msg['role'] == 'assistant' and prev_msg['tool_calls'] and loop.index0 < outer_index -%}
        {%- set assistant_idx.value = loop.index0 -%}
      {%- endif -%}
    {%- endfor -%}
    {%- set call_order = outer_index - assistant_idx.value -%}
    {%- set assistant_msg = messages[assistant_idx.value] -%}
    {%- set tool_call_count = assistant_msg['tool_calls'] | length -%}
    {%- if call_order == 1 -%}
      {{- '\n\n<function_results>' -}}
    {%- endif -%}
    {{- '\n<result>' + (message['content'] or '') + '</result>' -}}
    {%- if call_order == tool_call_count -%}
      {{- '\n</function_results>' -}}
      {%- set state.pending_asst_marker = false -%}
      {%- set state.pending_tool_marker = true -%}
    {%- endif -%}
  {%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt -%}
  {%- if state.pending_asst_marker -%}
    {{- '<｜Assistant｜>' -}}
    {%- if thinking -%}
      {{- thinking_start_token -}}
    {%- else -%}
      {{- thinking_start_token + thinking_end_token -}}
    {%- endif -%}
  {%- elif state.pending_tool_marker -%}
    {%- if thinking -%}
      {{- '\n\n' + thinking_start_token -}}
    {%- else -%}
      {{- '\n\n' + thinking_start_token + thinking_end_token -}}
    {%- endif -%}
  {%- endif -%}
{%- endif -%})jinja";

struct ReasoningFamilyTemplate {
  const char* name;
  const char* source;
  /// With thinking on, the generation prompt leaves the reasoning block open,
  /// so the model never generates the opener and the addon must stream it.
  bool forcesOpen;
  /// The same with thinking off (`reasoning_budget: 0`).
  bool forcesOpenWithThinkingOff;
};

/// GLM, DeepSeek and Qwen reasoning templates, with and without a forced-open
/// generation prompt. GLM-5.3-Flash opens `<think>` whatever
/// `enable_thinking` says.
inline constexpr std::array<ReasoningFamilyTemplate, 9>
    REASONING_FAMILY_TEMPLATES{{
        {"GLM-4.6", GLM46_CHAT_TEMPLATE, false, false},
        {"GLM-4.7-Flash", GLM47_FLASH_CHAT_TEMPLATE, true, false},
        {"GLM-5.3-Flash", GLM53_FLASH_CHAT_TEMPLATE, true, true},
        {"DeepSeek-R1-Distill",
         DEEPSEEK_R1_DISTILL_QWEN_CHAT_TEMPLATE,
         true,
         false},
        {"DeepSeek-V3.1", DEEPSEEK_V31_CHAT_TEMPLATE, true, false},
        {"DeepSeek-V3.2", DEEPSEEK_V32_CHAT_TEMPLATE, true, false},
        {"DeepSeek-V4-Flash", DEEPSEEK_V4_FLASH_CHAT_TEMPLATE, true, false},
        {"Qwen3", QWEN3_CHAT_TEMPLATE, false, false},
        {"Qwen3.8", QWEN38_CHAT_TEMPLATE, true, false},
    }};

/// What one user turn renders through @p tmpls: the opener the addon must
/// stream first, or empty when the template does not force the block open.
inline std::string
forcedOpenerOf(const common_chat_templates* tmpls, bool enableThinking) {
  common_chat_templates_inputs inputs;
  inputs.use_jinja = true;
  inputs.enable_thinking = enableThinking;
  inputs.add_generation_prompt = true;
  common_chat_msg user;
  user.role = "user";
  user.content = "What is 17 * 23?";
  inputs.messages = {user};
  const utils::PromptRenderResult rendered = utils::getPrompt(tmpls, inputs);
  if (!rendered.thinkingForcedOpen) {
    return {};
  }
  return utils::getThinkingForcedOpenText(
      rendered.generationPrompt, rendered.thinkingStartTag);
}

} // namespace qvac_lib_inference_addon_llama::test
