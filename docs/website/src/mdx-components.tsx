import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Mermaid } from '@/components/mermaid';
import type { MDXComponents } from 'mdx/types';
import * as TabsComponents from 'fumadocs-ui/components/tabs';
import * as StepComponents from 'fumadocs-ui/components/steps';
import * as React from "react";
import Link from "next/link";
import { GithubInfo } from 'fumadocs-ui/components/github-info';
import { CustomTabs, CustomTabsItem } from "@/components/custom-tabs";

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
    Mermaid,
    WrapCode,
    ButtonLink,
    GithubInfo,
    ...TabsComponents,
    Tabs: CustomTabs,
    Tab: CustomTabsItem,
    ...StepComponents,
    ...components,
  };
}