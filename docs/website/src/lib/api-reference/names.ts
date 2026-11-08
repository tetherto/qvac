/**
 * Field and function names per SDK language. The contract names fields in
 * camelCase, as JavaScript does; Python names them in snake_case, with a
 * trailing underscore on a Python keyword (`from` becomes `from_`), which is
 * the rule the Python client's own signatures follow.
 */

export type SdkLanguage = 'js' | 'python'

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
])

/** `modelId` → `model_id`; `HTTPServer` → `http_server`; `from` → `from_`. */
export function toSnakeCase(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
  return PYTHON_KEYWORDS.has(snake) ? `${snake}_` : snake
}

export function fieldName(name: string, language: SdkLanguage): string {
  return language === 'python' ? toSnakeCase(name) : name
}
