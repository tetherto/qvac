import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Mermaid } from '@/components/mermaid';
import type { MDXComponents } from 'mdx/types';
import * as TabsComponents from 'fumadocs-ui/components/tabs';
import * as StepComponents from 'fumadocs-ui/components/steps';
import * as React from "react";
import Link from "next/link";
import { GithubInfo } from 'fumadocs-ui/components/github-info';
import { Cards } from 'fumadocs-ui/components/card';
import { CustomTabs, CustomTabsItem } from "@/components/custom-tabs";
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
// import { AskAICodeBlock } from "@/components/ask-ai"; // disabled while we sort out the legacy fallback
import { FeaturesInfographic } from "@/components/features-infographic";
import { SmartAnchor, SmartCard } from "@/components/mdx-smart-card";

function WrapCode({ children }: { children: React.ReactNode }) {
  return <div className="fd-code-wrap">{children}</div>;
}

function ButtonLink({
  href,
  children,
  className = "",
  ...props
}: React.ComponentProps<typeof Link>) {
  return (
    <Link
      href={href}
      className={[
        // base
        "inline-flex items-center justify-center",
        "rounded-md px-3 py-1.5 text-sm font-medium",
        "transition-opacity hover:opacity-90",
        // cores (seguem o tema do Fumadocs)
        "bg-fd-primary text-fd-primary-foreground",
        // a11y
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-fd-background",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </Link>
  );
}

// use this function to get MDX components, you will need it for rendering MDX
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    // AskAICodeBlock disabled — the wrapper that injected the "Ask AI"
    // sparkles trigger into every code block is parked alongside the
    // other legacy-fallback steps. Re-enable by uncommenting the
    // import above and the `pre:` override below; the component itself
    // is preserved in `@/components/ask-ai/ask-ai-code-block.tsx`.
    // pre: AskAICodeBlock,
    // Override the default `Card` with one that flags its subtree as
    // "inside an anchor" so `SmartAnchor` below knows to degrade.
    // `Cards` is re-exported as-is (it's just a layout grid).
    Card: SmartCard,
    Cards,
    // Override the `a:` MDX mapping with a client component that
    // degrades to a `<span>` inside Cards (to avoid nested anchors)
    // and otherwise renders fumadocs's standard Link. Pages that need
    // relative-path resolution (the `createRelativeLink(source, page)`
    // behavior) should override `a:` via the `components` arg below
    // with a server-side wrapper that resolves the href BEFORE
    // rendering — see `(docs)/[[...slug]]/page.tsx`.
    a: SmartAnchor,
    Mermaid,
    WrapCode,
    ButtonLink,
    GithubInfo,
    ...TabsComponents,
    Tabs: CustomTabs,
    Tab: CustomTabsItem,
    Accordion,
    Accordions,
    FeaturesInfographic,
    ...StepComponents,
    ...components,
  };
}