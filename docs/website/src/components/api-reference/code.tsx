import { ServerCodeBlock } from 'fumadocs-ui/components/codeblock.rsc';

/**
 * A signature, usage line, or type, as the site's own code block:
 * highlighted at build time, framed, with a copy button.
 */
export function Code({ code, lang }: { code: string; lang: 'ts' | 'python' | 'bash' }) {
  return (
    <div className="qv-code">
      <ServerCodeBlock code={code} lang={lang} />
    </div>
  );
}
