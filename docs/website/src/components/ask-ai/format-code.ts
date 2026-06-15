import type { Plugin } from 'prettier';

/**
 * Inkeep's QA API collapses every run of leading indentation in code
 * fences to a single space (verified across all `inkeep-qa-*` models),
 * so the depth is gone by the time we receive the answer. For the
 * languages Prettier understands we can reconstruct it from the code's
 * own syntax. Everything else is returned unchanged.
 *
 * Prettier is loaded lazily (only when a code block is actually
 * formatted) so its weight never lands in the initial bundle, and any
 * parse failure - including the partial, not-yet-valid snippets seen
 * mid-stream - falls back to the original text instead of throwing.
 */

const LANGUAGE_PARSERS: Record<string, string> = {
  js: 'babel',
  javascript: 'babel',
  jsx: 'babel',
  mjs: 'babel',
  cjs: 'babel',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
};

async function loadPrettier(parser: string): Promise<{
  format: (typeof import('prettier/standalone'))['format'];
  plugins: Plugin[];
}> {
  const standalone = await import('prettier/standalone');
  const plugins: Plugin[] = [];

  if (parser === 'typescript') {
    const [ts, estree] = await Promise.all([
      import('prettier/plugins/typescript'),
      import('prettier/plugins/estree'),
    ]);
    plugins.push(ts as unknown as Plugin, estree as unknown as Plugin);
  } else if (parser === 'babel' || parser === 'json') {
    const [babel, estree] = await Promise.all([
      import('prettier/plugins/babel'),
      import('prettier/plugins/estree'),
    ]);
    plugins.push(babel as unknown as Plugin, estree as unknown as Plugin);
  } else if (parser === 'css' || parser === 'scss' || parser === 'less') {
    const postcss = await import('prettier/plugins/postcss');
    plugins.push(postcss as unknown as Plugin);
  }

  return { format: standalone.format, plugins };
}

/**
 * Best-effort re-indent of a code snippet. Returns the original string
 * untouched for unsupported languages or when Prettier can't parse it.
 */
export async function formatCode(code: string, language?: string): Promise<string> {
  const parser = language ? LANGUAGE_PARSERS[language.toLowerCase()] : undefined;
  if (!parser) return code;

  try {
    const { format, plugins } = await loadPrettier(parser);
    const formatted = await format(code, {
      parser,
      plugins,
      printWidth: 80,
      tabWidth: 2,
      semi: true,
    });
    // Prettier always appends a trailing newline; drop it so the code
    // block doesn't render a blank final line.
    return formatted.replace(/\n+$/, '');
  } catch {
    return code;
  }
}
