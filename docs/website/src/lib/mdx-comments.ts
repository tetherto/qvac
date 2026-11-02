/**
 * MDX comments, and what the site does with them.
 *
 * A comment's body never renders, so it is not content: not a link to check,
 * not prose to hand an agent. The docs use them to park a passage beside the
 * one it will replace — the Kotlin client's, until that package ships — and
 * such a passage reads exactly like the live one, links and all. Anything
 * that reads a page as text rather than as a rendered tree therefore has to
 * drop them first, or it will report a link the site does not serve and tell
 * an agent about a page that is not published.
 */
const MDX_COMMENT = /\{\s*\/\*[\s\S]*?\*\/\s*\}/g;

/** The content without its comments. */
export function stripMdxComments(content: string): string {
  return content.replace(MDX_COMMENT, '');
}
