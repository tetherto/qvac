#pragma once

namespace qvac_lib_inference_addon_llama::test {

// The chat template of Qwen/Qwen3.8-27B and Qwen/Qwen3.8-Flash-Next
// (identical `chat_template.jinja`). Raises "No user query found" on a
// conversation without a user turn.
inline constexpr const char* QWEN38_CHAT_TEMPLATE =
    R"jinja({%- set image_count = namespace(value=0) %}
{%- set video_count = namespace(value=0) %}
{%- macro render_content(content, do_vision_count, is_system_content=false) %}
    {%- if content is string %}
        {{- content }}
    {%- elif content is iterable and content is not mapping %}
        {%- for item in content %}
            {%- if 'image' in item or 'image_url' in item or item.type == 'image' %}
                {%- if is_system_content %}
                    {{- raise_exception('System message cannot contain images.') }}
                {%- endif %}
                {%- if do_vision_count %}
                    {%- set image_count.value = image_count.value + 1 %}
                {%- endif %}
                {%- if add_vision_id %}
                    {{- 'Picture ' ~ image_count.value ~ ': ' }}
                {%- endif %}
                {{- '<|vision_start|><|image_pad|><|vision_end|>' }}
            {%- elif 'video' in item or item.type == 'video' %}
                {%- if is_system_content %}
                    {{- raise_exception('System message cannot contain videos.') }}
                {%- endif %}
                {%- if do_vision_count %}
                    {%- set video_count.value = video_count.value + 1 %}
                {%- endif %}
                {%- if add_vision_id %}
                    {{- 'Video ' ~ video_count.value ~ ': ' }}
                {%- endif %}
                {{- '<|vision_start|><|video_pad|><|vision_end|>' }}
            {%- elif 'text' in item %}
                {{- item.text }}
            {%- else %}
                {{- raise_exception('Unexpected item type in content.') }}
            {%- endif %}
        {%- endfor %}
    {%- elif content is none or content is undefined %}
        {{- '' }}
    {%- else %}
        {{- raise_exception('Unexpected content type.') }}
    {%- endif %}
{%- endmacro %}
{%- if not messages %}
    {{- raise_exception('No messages provided.') }}
{%- endif %}
{%- set reasoning_instructions = '' %}
{%- if enable_thinking is undefined or enable_thinking is true %}
    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
    {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
        {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '. Supported types are xhigh (default), medium, and low.') }}
    {%- endif %}
    {%- if resolved_reasoning_effort == 'xhigh' %}
        {%- set reasoning_instructions = 'Reasoning effort is set to xhigh. Please think carefully through the task, validate key assumptions, consider plausible alternatives, and prioritize correctness, consistency, and clarity in the final answer.' %}
    {%- elif resolved_reasoning_effort == 'low' %}
        {%- set reasoning_instructions = 'Reasoning effort is set to low. Keep your thinking brief and focused, moving directly to the conclusion without unnecessary elaboration.' %}
    {%- endif %}
{%- endif %}
{%- if tools and tools is iterable and tools is not mapping %}
    {{- '<|im_start|>system\n' }}
    {%- if reasoning_instructions %}
        {{- reasoning_instructions + '\n\n' }}
    {%- endif %}
    {{- "# Tools\n\nYou have access to the following functions:\n\n<tools>" }}
    {%- for tool in tools %}
        {{- "\n" }}
        {{- tool | tojson }}
    {%- endfor %}
    {{- "\n</tools>" }}
    {{- '\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>' }}
    {%- if messages[0].role == 'system' %}
        {%- set content = render_content(messages[0].content, false, true)|trim %}
        {%- if content %}
            {{- '\n\n' + content }}
        {%- endif %}
    {%- endif %}
    {{- '<|im_end|>\n' }}
{%- else %}
    {%- if messages[0].role == 'system' %}
        {%- set content = render_content(messages[0].content, false, true)|trim %}
        {%- if content %}
            {{- '<|im_start|>system\n' + (reasoning_instructions + '\n\n' if reasoning_instructions else '')  + content + '<|im_end|>\n' }}
        {%- elif reasoning_instructions %}
            {{- '<|im_start|>system\n' + reasoning_instructions + '<|im_end|>\n' }}
        {%- endif %}
    {%- elif reasoning_instructions %}
        {{- '<|im_start|>system\n' + reasoning_instructions + '<|im_end|>\n' }}
    {%- endif %}
{%- endif %}
{%- set ns = namespace(multi_step_tool=true, last_query_index=messages|length - 1) %}
{%- for message in messages[::-1] %}
    {%- set index = (messages|length - 1) - loop.index0 %}
    {%- if ns.multi_step_tool and message.role == "user" %}
        {%- set content = render_content(message.content, false)|trim %}
        {%- if not(content.startswith('<tool_response>') and content.endswith('</tool_response>')) %}
            {%- set ns.multi_step_tool = false %}
            {%- set ns.last_query_index = index %}
        {%- endif %}
    {%- endif %}
{%- endfor %}
{%- if ns.multi_step_tool %}
    {{- raise_exception('No user query found in messages.') }}
{%- endif %}
{%- for message in messages %}
    {%- set content = render_content(message.content, true)|trim %}
    {%- if message.role == "system" %}
        {%- if not loop.first %}
            {{- raise_exception('System message must be at the beginning.') }}
        {%- endif %}
    {%- elif message.role == "user" %}
        {{- '<|im_start|>' + message.role + '\n' + content + '<|im_end|>' + '\n' }}
    {%- elif message.role == "assistant" %}
        {%- set reasoning_content = '' %}
        {%- if message.reasoning_content is string %}
            {%- set reasoning_content = message.reasoning_content %}
        {%- endif %}
        {%- set reasoning_content = reasoning_content|trim %}
        {%- if preserve_thinking is undefined or preserve_thinking is true or loop.index0 > ns.last_query_index %}
            {{- '<|im_start|>' + message.role + '\n<think>\n' + reasoning_content + '\n</think>\n\n' + content }}
        {%- else %}
            {{- '<|im_start|>' + message.role + '\n' + content }}
        {%- endif %}
        {%- if message.tool_calls and message.tool_calls is iterable and message.tool_calls is not mapping %}
            {%- for tool_call in message.tool_calls %}
                {%- if tool_call.function is defined %}
                    {%- set tool_call = tool_call.function %}
                {%- endif %}
                {%- if loop.first %}
                    {%- if content|trim %}
                        {{- '\n\n<tool_call>\n<function=' + tool_call.name + '>\n' }}
                    {%- else %}
                        {{- '<tool_call>\n<function=' + tool_call.name + '>\n' }}
                    {%- endif %}
                {%- else %}
                    {{- '\n<tool_call>\n<function=' + tool_call.name + '>\n' }}
                {%- endif %}
                {%- if tool_call.arguments is defined and tool_call.arguments != '' %}
                    {%- for args_name, args_value in tool_call.arguments|items %}
                        {{- '<parameter=' + args_name + '>\n' }}
                        {%- set args_value = args_value | string if args_value is string else args_value | tojson | safe %}
                        {{- args_value }}
                        {{- '\n</parameter>\n' }}
                    {%- endfor %}
                {%- endif %}
                {{- '</function>\n</tool_call>' }}
            {%- endfor %}
        {%- endif %}
        {{- '<|im_end|>\n' }}
    {%- elif message.role == "tool" %}
        {%- if loop.previtem and loop.previtem.role != "tool" %}
            {{- '<|im_start|>user' }}
        {%- endif %}
        {{- '\n<tool_response>\n' }}
        {{- content }}
        {{- '\n</tool_response>' }}
        {%- if not loop.last and loop.nextitem.role != "tool" %}
            {{- '<|im_end|>\n' }}
        {%- elif loop.last %}
            {{- '<|im_end|>\n' }}
        {%- endif %}
    {%- else %}
        {{- raise_exception('Unexpected message role.') }}
    {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
    {{- '<|im_start|>assistant\n' }}
    {%- if enable_thinking is defined and enable_thinking is false %}
        {{- '<think>\n\n</think>\n\n' }}
    {%- else %}
        {{- '<think>\n' }}
    {%- endif %}
{%- endif %})jinja";

// The chat template of zai-org/GLM-5.3-Flash. Renders the tools as a leading
// `<|system|>` block, with or without a user turn.
inline constexpr const char* GLM53_FLASH_CHAT_TEMPLATE = R"jinja([gMASK]<sop>
{%- set effective_reasoning_effort = reasoning_effort if reasoning_effort is defined and reasoning_effort in ['low', 'high'] else 'max' -%}
{%- if effective_reasoning_effort is not none -%}<|system|>Reasoning Effort: {{ effective_reasoning_effort | capitalize }}{%- endif -%}
{%- set clear_thinking = clear_thinking if clear_thinking is defined else false -%}
{%- if tools -%}
{%- macro tool_to_json(tool) -%}
    {%- set ns_tool = namespace(first=true) -%}
    {{ '{' -}}
    {%- for k, v in tool.items() -%}
        {%- if k != 'defer_loading' and k != 'strict' -%}
            {%- if not ns_tool.first -%}{{- ', ' -}}{%- endif -%}
            {%- set ns_tool.first = false -%}
            "{{ k }}": {{ v | tojson(ensure_ascii=False) }}
        {%- endif -%}
    {%- endfor -%}
    {{- '}' -}}
{%- endmacro -%}
{%- macro tool_references_to_response(refs) -%}
    {{- '<tool_response><tools>\n' -}}
    {%- for tr in refs -%}
        {%- for tool in tools -%}
            {%- if 'function' in tool -%}
                {%- set tool = tool['function'] -%}
            {%- endif -%}
            {%- if tool.name == tr.name -%}
                {{- tool_to_json(tool) + '\n' -}}
            {%- endif -%}
        {%- endfor -%}
    {%- endfor -%}
    {{- '</tools></tool_response>' -}}
{%- endmacro -%}
<|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{% for tool in tools %}
{%- if 'function' in tool -%}
    {%- set tool = tool['function'] -%}
{%- endif -%}
{% if tool.defer_loading is not defined or not tool.defer_loading %}
{{ tool_to_json(tool) }}
{% endif %}
{% endfor %}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}<arg_key>{arg-key-1}</arg_key><arg_value>{arg-value-1}</arg_value><arg_key>{arg-key-2}</arg_key><arg_value>{arg-value-2}</arg_value>...</tool_call>{%- endif -%}
{%- macro emit_image() -%}<|begin_of_image|><|image|><|end_of_image|>{%- endmacro -%}
{%- macro emit_video() -%}<|begin_of_video|><|video|><|end_of_video|>{%- endmacro -%}
{%- macro emit_audio() -%}<|begin_of_audio|><|end_of_audio|>{%- endmacro -%}
{%- macro visible_text(content) -%}
    {%- if content is string -%}
        {{- content -}}
    {%- elif content is iterable and content is not mapping -%}
        {%- for item in content -%}
            {%- if item is mapping and item.type == 'text' -%}
                {{- item.text -}}
            {%- elif item is string -%}
                {{- item -}}
            {%- elif item is mapping and item.type in ['image', 'image_url'] -%}
                {{- emit_image() -}}
            {%- elif item is mapping and item.type in ['video', 'video_url'] -%}
                {{- emit_video() -}}
            {%- elif item is mapping and item.type in ['audio', 'audio_url', 'input_audio'] -%}
                {{- emit_audio() -}}
            {%- endif -%}
        {%- endfor -%}
    {%- elif content is not none -%}
        {{- content -}}
    {%- endif -%}
{%- endmacro -%}
{%- macro tool_response(text) -%}
{{- '<tool_response>' + text + '</tool_response>' -}}
{%- endmacro -%}
{%- macro render_tool_response(m) -%}
{%- if m.content is string -%}
    {{- tool_response(m.content) -}}
{%- elif m.content and m.content is not mapping and m.content.0.type == "tool_reference" -%}
    {{- tool_references_to_response(m.content) -}}
{%- elif is_list_of_outputs(m) -%}
    {%- for tr in m.content -%}
        {%- if tr.output is iterable and tr.output is not string and tr.output is not mapping and tr.output and tr.output.0.type == "tool_reference" -%}
            {{- tool_references_to_response(tr.output) -}}
        {%- else -%}
            {{- tool_response(visible_text(tr.output)) -}}
        {%- endif -%}
    {%- endfor -%}
{%- else -%}
    {{- tool_response(visible_text(m.content)) -}}
{%- endif -%}
{%- endmacro -%}
{%- macro id_of(obj) -%}
    {%- if obj.tool_call_id -%}
        {{- obj.tool_call_id -}}
    {%- elif obj.id -%}
        {{- obj.id -}}
    {%- endif -%}
{%- endmacro -%}
{%- macro is_list_of_outputs(m) -%}
    {%- if m.content and m.content.0.output is defined -%}1{%- endif -%}
{%- endmacro -%}
{%- macro has_dup_tool_result_id(lo, hi, target) -%}
    {%- set ns_cnt = namespace(n=0) -%}
    {%- for k in range(lo, hi + 1) -%}
        {%- set m = messages[k] -%}
        {%- if is_list_of_outputs(m) -%}
            {%- for entry in m.content -%}
                {%- if id_of(entry) == target -%}
                    {%- set ns_cnt.n = ns_cnt.n + 1 -%}
                {%- endif -%}
            {%- endfor -%}
        {%- elif id_of(m) == target -%}
            {%- set ns_cnt.n = ns_cnt.n + 1 -%}
        {%- endif -%}
        {%- if ns_cnt.n > 1 -%}{%- break -%}{%- endif -%}
    {%- endfor -%}
    {%- if ns_cnt.n > 1 -%}1{%- endif -%}
{%- endmacro -%}
{%- macro tc_id_exists(tcs, target) -%}
    {%- set ns_f = namespace(found=false) -%}
    {%- for tc in tcs -%}
        {%- if id_of(tc) == target -%}
            {%- set ns_f.found = true -%}
            {%- break -%}
        {%- endif -%}
    {%- endfor -%}
    {%- if ns_f.found -%}1{%- endif -%}
{%- endmacro -%}
{%- set ns = namespace(last_user_index=-1) -%}
{%- for m in messages %}
    {%- if m.role == 'user' %}
        {%- set ns.last_user_index = loop.index0 -%}
    {%- endif %}
{%- endfor %}
{%- for m in messages -%}
{%- if m.role == 'user' -%}<|user|>{{ visible_text(m.content) }}
{%- elif m.role == 'assistant' -%}
<|assistant|>
{%- set content = visible_text(m.content) %}
{%- if m.reasoning_content is string %}
    {%- set reasoning_content = m.reasoning_content %}
{%- elif '</think>' in content %}
    {%- set reasoning_content = content.split('</think>')[0].split('<think>')[-1] %}
    {%- set content = content.split('</think>')[-1] %}
{%- endif %}
{%- if (not clear_thinking or loop.index0 > ns.last_user_index) and reasoning_content is defined -%}
{{ '<think>' + reasoning_content +  '</think>'}}
{%- else -%}
{{ '<think></think>' }}
{%- endif -%}
{%- if content.strip() -%}
{{ content.strip() }}
{%- endif -%}
{% if m.tool_calls %}
{% for tc in m.tool_calls %}
{%- if tc.function %}
    {%- set tc = tc.function %}
{%- endif %}
{{- '<tool_call>' ~ tc.name -}}
{% set _args = tc.arguments %}{% for k, v in _args.items() %}<arg_key>{{ k }}</arg_key><arg_value>{{ v | tojson(ensure_ascii=False) if v is not string else v }}</arg_value>{% endfor %}</tool_call>{% endfor %}
{% endif %}
{%- elif m.role == 'tool' -%}
{%- if loop.first or (messages[loop.index0 - 1].role != "tool") %}
    {{- '<|observation|>' -}}
    {%- set block_start = loop.index0 -%}
    {%- set ns_blk = namespace(end=block_start) -%}
    {%- for j in range(block_start, messages|length) -%}
        {%- if messages[j].role == 'tool' -%}
            {%- set ns_blk.end = j -%}
        {%- else -%}
            {%- break -%}
        {%- endif -%}
    {%- endfor -%}
    {%- set ns_a = namespace(tool_calls=none) -%}
    {%- if block_start > 0 and messages[block_start - 1].role == 'assistant' and messages[block_start - 1].tool_calls -%}
        {%- set ns_a.tool_calls = messages[block_start - 1].tool_calls -%}
    {%- endif -%}
    {%- set ns_chk = namespace(can_sort=true, res=[], mk=[], ek=[], tcs=[]) -%}
    {%- for k in range(block_start, ns_blk.end + 1) -%}
        {%- set m = messages[k] -%}
        {%- if is_list_of_outputs(m) -%}
            {%- for entry in m.content -%}
                {%- set ns_chk.res = ns_chk.res + [id_of(entry)] -%}
                {%- set ns_chk.mk = ns_chk.mk + [k] -%}
                {%- set ns_chk.ek = ns_chk.ek + [loop.index0] -%}
            {%- endfor -%}
        {%- else -%}
            {%- set ns_chk.res = ns_chk.res + [id_of(m)] -%}
            {%- set ns_chk.mk = ns_chk.mk + [k] -%}
            {%- set ns_chk.ek = ns_chk.ek + [-1] -%}
        {%- endif -%}
    {%- endfor -%}
    {%- if not ns_a.tool_calls -%}
        {%- set ns_chk.can_sort = false -%}
    {%- else -%}
        {%- for tc in ns_a.tool_calls -%}
            {%- set ns_chk.tcs = ns_chk.tcs + [id_of(tc)] -%}
        {%- endfor -%}
        {%- if '' in ns_chk.res or '' in ns_chk.tcs -%}
            {%- set ns_chk.can_sort = false -%}
        {%- elif ns_chk.res | unique(case_sensitive=true) | list | length != ns_chk.res | length -%}
            {%- set ns_chk.can_sort = false -%}
        {%- elif ns_chk.tcs | unique(case_sensitive=true) | list | length != ns_chk.tcs | length -%}
            {%- set ns_chk.can_sort = false -%}
        {%- else -%}
            {%- for eid in ns_chk.res -%}
                {%- if eid not in ns_chk.tcs -%}
                    {%- set ns_chk.can_sort = false -%}
                    {%- break -%}
                {%- endif -%}
            {%- endfor -%}
        {%- endif -%}
    {%- endif -%}
    {%- if ns_chk.can_sort -%}
        {%- set ns_ord = namespace(res=[], tcs=[], j=0, pairs=[]) -%}
        {%- for eid in ns_chk.res -%}
            {%- set ns_ord.res = ns_ord.res + [{'id': eid, 'p': loop.index0}] -%}
        {%- endfor -%}
        {%- for tc_id in ns_chk.tcs -%}
            {%- set ns_ord.tcs = ns_ord.tcs + [{'id': tc_id, 'i': loop.index0}] -%}
        {%- endfor -%}
        {%- set ns_ord.res = ns_ord.res | sort(attribute='id', case_sensitive=true) -%}
        {%- for tc in ns_ord.tcs | sort(attribute='id', case_sensitive=true) -%}
            {%- if ns_ord.j < ns_ord.res | length and ns_ord.res[ns_ord.j].id == tc.id -%}
                {%- set ns_ord.pairs = ns_ord.pairs + [{'i': tc.i, 'p': ns_ord.res[ns_ord.j].p}] -%}
                {%- set ns_ord.j = ns_ord.j + 1 -%}
            {%- endif -%}
        {%- endfor -%}
        {%- for pair in ns_ord.pairs | sort(attribute='i') -%}
            {%- set m = messages[ns_chk.mk[pair.p]] -%}
            {%- if ns_chk.ek[pair.p] >= 0 -%}
                {%- set entry = m.content[ns_chk.ek[pair.p]] -%}
                {%- if entry.output is iterable and entry.output is not string and entry.output is not mapping and entry.output and entry.output.0.type == "tool_reference" -%}
                    {{- tool_references_to_response(entry.output) -}}
                {%- else -%}
                    {{- tool_response(visible_text(entry.output)) -}}
                {%- endif -%}
            {%- else -%}
                {{- render_tool_response(m) -}}
            {%- endif -%}
        {%- endfor -%}
    {%- else -%}
        {%- for k in range(block_start, ns_blk.end + 1) -%}
            {{- render_tool_response(messages[k]) -}}
        {%- endfor -%}
    {%- endif -%}
{% endif -%}
{%- elif m.role == 'system' -%}
<|system|>{{ visible_text(m.content) }}
{%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt -%}
    <|assistant|>{{- '<think>' -}}
{%- endif -%}
)jinja";

// The DeepSeek V4 Flash chat template bundled with llama.cpp
// (models/templates/deepseek-ai-DeepSeek-V4-Flash-0731.jinja). Appends the
// tools to the system prompt, with or without a user turn.
inline constexpr const char* DEEPSEEK_V4_FLASH_CHAT_TEMPLATE =
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
{%- if not drop_thinking is defined -%}
  {%- set drop_thinking = true -%}
{%- endif -%}
{%- set dsml_token = '｜DSML｜' -%}
{%- set thinking_start_token = '<think>' -%}
{%- set thinking_end_token = '</think>' -%}
{%- set reasoning_effort_high = 'Reasoning Effort: Absolute maximum with no shortcuts permitted.\nYou MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.\nExplicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.\n\n' -%}
{%- set reasoning_effort_max = 'Reasoning Effort: Beyond maximum — exhaustive, relentless, and uncompromising.\nYou MUST reason with the utmost depth and rigor, leaving absolutely nothing to chance: exhaustively decompose the problem into its most fundamental components, trace every causal chain to its root, and resolve the underlying cause rather than any surface symptom.\nDo not stop reasoning until you have independently verified the solution from multiple angles and are certain that no assumption remains unchecked and no error remains undiscovered.\n\n' -%}
{%- set response_format_template = '## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n' -%}
{%- set has_tools = false -%}
{%- set tools_header = '## Tools\n\nYou have access to a set of tools to help answer the user\'s question. You can invoke tools by writing a "<' + dsml_token + 'tool_calls>" block like the following:\n\n<' + dsml_token + 'tool_calls>\n<' + dsml_token + 'invoke name="$TOOL_NAME">\n<' + dsml_token + 'parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</' + dsml_token + 'parameter>\n...\n</' + dsml_token + 'invoke>\n<' + dsml_token + 'invoke name="$TOOL_NAME2">\n...\n</' + dsml_token + 'invoke>\n</' + dsml_token + 'tool_calls>\n\nString parameters should be specified as is and set `string="true"`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set `string="false"`.\n\nIf thinking_mode is enabled (triggered by ' + thinking_start_token + '), you MUST output your complete reasoning inside ' + thinking_start_token + '...' + thinking_end_token + ' BEFORE any tool calls or final response.\n\nOtherwise, output directly after ' + thinking_end_token + ' with tool calls or final response.\n\n### Available Tool Schemas\n\n' -%}
{%- set tools_footer = '\nYou MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.\n' -%}
{%- set ns = namespace(system_prompt='', is_first_sp=true, has_tool_calls=false) -%}
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
  {%- set has_tools = true -%}
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
{%- if response_format is defined -%}
  {%- if ns.system_prompt -%}
    {%- set ns.system_prompt = ns.system_prompt + '\n\n' -%}
  {%- endif -%}
  {%- set ns.system_prompt = ns.system_prompt + response_format_template + (response_format | tojson) -%}
{%- endif -%}
{{- bos_token -}}
{%- if messages and thinking and reasoning_effort is defined and reasoning_effort == 'high' -%}
  {{- reasoning_effort_high -}}
{%- elif messages and thinking and reasoning_effort is defined and reasoning_effort == 'max' -%}
  {{- reasoning_effort_max -}}
{%- endif -%}
{{- ns.system_prompt -}}
{%- set last_user_idx = namespace(value=-1) -%}
{%- for message in messages -%}
  {%- if message['role'] == 'user' or message['role'] == 'developer' or message['role'] == 'tool' -%}
    {%- set last_user_idx.value = loop.index0 -%}
  {%- endif -%}
{%- endfor -%}
{%- set state = namespace(in_user=false) -%}
{%- for message in messages -%}
  {%- if message['role'] == 'tool' -%}
    {%- set ns.has_tool_calls = true -%}
  {%- endif -%}
{%- endfor -%}
{%- for message in messages -%}
  {%- if message['role'] == 'user' or message['role'] == 'developer' -%}
    {%- if state.in_user -%}
      {{- '\n\n' -}}
    {%- else -%}
      {{- '<｜User｜>' -}}
      {%- set state.in_user = true -%}
    {%- endif -%}
    {{- message['content'] or '' -}}
  {%- elif message['role'] == 'tool' -%}
    {%- if state.in_user -%}
      {{- '\n\n' -}}
    {%- else -%}
      {{- '<｜User｜>' -}}
      {%- set state.in_user = true -%}
    {%- endif -%}
    {{- '<tool_result>' + (message['content'] or '') + '</tool_result>' -}}
  {%- elif message['role'] == 'assistant' -%}
    {%- set state.in_user = false -%}
    {{- '<｜Assistant｜>' -}}
    {%- set is_after_last_user = loop.index0 > last_user_idx.value -%}
    {%- set keep_reasoning = thinking and ((not drop_thinking) or has_tools or is_after_last_user or ns.has_tool_calls) -%}
    {%- if keep_reasoning -%}
      {{- thinking_start_token -}}
      {%- if message['reasoning_content'] is defined and message['reasoning_content'] -%}
        {{- message['reasoning_content'] -}}
      {%- endif -%}
      {{- thinking_end_token -}}
    {%- else -%}
      {{- thinking_end_token -}}
    {%- endif -%}
    {%- if message['content'] is defined and message['content'] -%}
      {{- message['content'] -}}
    {%- endif -%}
    {%- if message['tool_calls'] -%}
      {{- '\n\n<' + dsml_token + 'tool_calls>\n' -}}
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
        {%- if not args -%}
          {{- '\n' -}}
        {%- endif -%}
        {{- '</' + dsml_token + 'invoke>\n' -}}
      {%- endfor -%}
      {{- '</' + dsml_token + 'tool_calls>' -}}
    {%- endif -%}
    {{- '<｜end▁of▁sentence｜>' -}}
  {%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt -%}
  {{- '<｜Assistant｜>' -}}
  {%- if thinking -%}
    {{- thinking_start_token -}}
  {%- else -%}
    {{- thinking_end_token -}}
  {%- endif -%}
{%- endif -%}
)jinja";

} // namespace qvac_lib_inference_addon_llama::test
