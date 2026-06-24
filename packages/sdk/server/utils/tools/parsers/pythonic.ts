import type { Tool, ToolCall, ToolCallError } from "@/schemas";
import {
  generateStableToolCallId,
  validateToolArguments,
  type ParserResult,
} from "@/server/utils/tools/shared";

// Pythonic `[name(k=v), ...]` arrays. LFM 2.x is auto-routed; Llama-style
// tokens are kept for callers that opt in via `completion({ toolDialect:
// "pythonic" })` for a model known to emit Pythonic. Pure string parsing —
// no eval/vm/Function (untrusted model output).
const PYTHONIC_LFM_OPEN = "<|tool_call_start|>";
const PYTHONIC_LFM_CLOSE = "<|tool_call_end|>";
const PYTHONIC_LLAMA_OPEN = "<|start_header_id|>tool_call<|end_header_id|>";
const PYTHONIC_LLAMA_CLOSE = "<|eot_id|>";

function locatePythonicCallList(text: string): string | null {
  const lfmStart = text.indexOf(PYTHONIC_LFM_OPEN);
  if (lfmStart !== -1) {
    const after = text.slice(lfmStart + PYTHONIC_LFM_OPEN.length);
    const end = after.indexOf(PYTHONIC_LFM_CLOSE);
    return end === -1 ? after : after.slice(0, end);
  }

  const llamaStart = text.indexOf(PYTHONIC_LLAMA_OPEN);
  if (llamaStart !== -1) {
    const after = text.slice(llamaStart + PYTHONIC_LLAMA_OPEN.length);
    const end = after.indexOf(PYTHONIC_LLAMA_CLOSE);
    return end === -1 ? after : after.slice(0, end);
  }

  // Identifier+`(` requirement rejects JSON arrays and plain bracketed lists.
  const bareMatch = /\[\s*[A-Za-z_]\w*\s*\(/.exec(text);
  if (bareMatch) return text.slice(bareMatch.index);

  return null;
}

type Scanner = { text: string; pos: number };

function pyPeek(s: Scanner, offset = 0): string {
  return s.text[s.pos + offset] ?? "";
}

function pyConsume(s: Scanner): string {
  const c = s.text[s.pos] ?? "";
  s.pos++;
  return c;
}

function pySkipWs(s: Scanner): void {
  while (/\s/.test(pyPeek(s))) s.pos++;
}

function pyParseString(s: Scanner): string {
  const quote = pyConsume(s);
  let out = "";
  while (s.pos < s.text.length && pyPeek(s) !== quote) {
    if (pyPeek(s) === "\\") {
      s.pos++;
      const esc = pyConsume(s);
      switch (esc) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "\\":
          out += "\\";
          break;
        case "'":
          out += "'";
          break;
        case '"':
          out += '"';
          break;
        case "0":
          out += "\0";
          break;
        default:
          out += esc;
          break;
      }
    } else {
      out += pyConsume(s);
    }
  }
  if (s.pos >= s.text.length) {
    throw new Error("Unterminated string literal");
  }
  pyConsume(s);
  return out;
}

function pyParseNumber(s: Scanner): number {
  const start = s.pos;
  if (pyPeek(s) === "-" || pyPeek(s) === "+") s.pos++;
  while (/\d/.test(pyPeek(s))) s.pos++;
  if (pyPeek(s) === ".") {
    s.pos++;
    while (/\d/.test(pyPeek(s))) s.pos++;
  }
  if (pyPeek(s) === "e" || pyPeek(s) === "E") {
    s.pos++;
    if (pyPeek(s) === "-" || pyPeek(s) === "+") s.pos++;
    while (/\d/.test(pyPeek(s))) s.pos++;
  }
  const literal = s.text.slice(start, s.pos);
  const n = Number(literal);
  if (Number.isNaN(n) || literal.length === 0) {
    throw new Error(`Invalid number literal: ${JSON.stringify(literal)}`);
  }
  return n;
}

function pyParseIdentifier(s: Scanner): string {
  if (!/[A-Za-z_]/.test(pyPeek(s))) {
    throw new Error(`Expected identifier, got ${JSON.stringify(pyPeek(s))}`);
  }
  const start = s.pos;
  while (/[\w]/.test(pyPeek(s))) s.pos++;
  return s.text.slice(start, s.pos);
}

// Identifier-as-string fallback: any bare word that isn't `True`/`False`/`None`
// is returned as a string, so `[get_weather(city=Paris)]` still produces
// `{ city: "Paris" }`. Side-effect: lowercase `null` / `true` / `false` from
// JS-trained models also coerce to strings — validate against your tool schema.
function pyParseValue(s: Scanner): unknown {
  pySkipWs(s);
  const c = pyPeek(s);
  if (c === '"' || c === "'") return pyParseString(s);
  if (c === "[") return pyParseList(s);
  if (c === "{") return pyParseDict(s);
  if (c === "-" || c === "+" || /\d/.test(c)) return pyParseNumber(s);
  if (/[A-Za-z_]/.test(c)) {
    const id = pyParseIdentifier(s);
    if (id === "True") return true;
    if (id === "False") return false;
    if (id === "None") return null;
    return id;
  }
  throw new Error(`Unexpected character: ${JSON.stringify(c)}`);
}

// Drives `parseItem, sep, parseItem, sep, ..., close` loops with trailing-
// comma tolerance. Assumes the open delimiter was already consumed.
function pyParseDelimited(
  s: Scanner,
  close: string,
  context: string,
  parseItem: () => void,
): void {
  pySkipWs(s);
  if (pyPeek(s) === close) {
    pyConsume(s);
    return;
  }
  for (;;) {
    pySkipWs(s);
    parseItem();
    pySkipWs(s);
    const sep = pyPeek(s);
    if (sep === ",") {
      pyConsume(s);
      pySkipWs(s);
      if (pyPeek(s) === close) {
        pyConsume(s);
        return;
      }
    } else if (sep === close) {
      pyConsume(s);
      return;
    } else {
      throw new Error(
        `Expected , or ${close} in ${context}, got ${JSON.stringify(sep)}`,
      );
    }
  }
}

function pyParseList(s: Scanner): unknown[] {
  pyConsume(s);
  const items: unknown[] = [];
  pyParseDelimited(s, "]", "list", () => {
    items.push(pyParseValue(s));
  });
  return items;
}

function pyParseDict(s: Scanner): Record<string, unknown> {
  pyConsume(s);
  const obj: Record<string, unknown> = {};
  pyParseDelimited(s, "}", "dict", () => {
    const c = pyPeek(s);
    let key: string;
    if (c === '"' || c === "'") key = pyParseString(s);
    else if (/[A-Za-z_]/.test(c)) key = pyParseIdentifier(s);
    else throw new Error(`Expected dict key, got ${JSON.stringify(c)}`);
    pySkipWs(s);
    if (pyConsume(s) !== ":") {
      throw new Error(`Expected : after dict key "${key}"`);
    }
    obj[key] = pyParseValue(s);
  });
  return obj;
}

type PythonicCall = { name: string; arguments: Record<string, unknown> };

function pyParseArgList(s: Scanner): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  pyParseDelimited(s, ")", "args", () => {
    const key = pyParseIdentifier(s);
    pySkipWs(s);
    if (pyConsume(s) !== "=") {
      throw new Error(`Expected = after arg name "${key}"`);
    }
    args[key] = pyParseValue(s);
  });
  return args;
}

function pyParseCallList(text: string): PythonicCall[] {
  const s: Scanner = { text, pos: 0 };
  pySkipWs(s);
  if (pyConsume(s) !== "[") {
    throw new Error("Expected [ at start of call list");
  }
  const calls: PythonicCall[] = [];
  pyParseDelimited(s, "]", "call list", () => {
    const name = pyParseIdentifier(s);
    pySkipWs(s);
    if (pyConsume(s) !== "(") {
      throw new Error(`Expected ( after call name "${name}"`);
    }
    calls.push({ name, arguments: pyParseArgList(s) });
  });
  return calls;
}

export function parsePythonicFormat(
  text: string,
  tools: Tool[],
): ParserResult {
  const toolCalls: ToolCall[] = [];
  const errors: ToolCallError[] = [];

  const slice = locatePythonicCallList(text);
  if (slice === null) {
    return { matched: false, toolCalls, errors };
  }

  let calls: PythonicCall[];
  try {
    calls = pyParseCallList(slice);
  } catch (error) {
    errors.push({
      code: "PARSE_ERROR",
      message: `Failed to parse Pythonic tool call list: ${error instanceof Error ? error.message : String(error)}`,
      raw: slice,
    });
    return { matched: true, toolCalls, errors };
  }

  for (const call of calls) {
    const raw = `${call.name}(${JSON.stringify(call.arguments)})`;
    const validation = validateToolArguments(call.name, call.arguments, tools);
    if (!validation.isValid && validation.error) {
      errors.push({ ...validation.error, raw });
      continue;
    }
    toolCalls.push({
      id: generateStableToolCallId(call.name, call.arguments),
      name: call.name,
      arguments: call.arguments,
      raw,
    });
  }

  return { matched: true, toolCalls, errors };
}
