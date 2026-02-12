"use client";

import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";

export type CustomTabsItemProps = {
  value: string;
  label: React.ReactNode;

  /**
   * Docusaurus-compatible:
   * <TabItem default> ... </TabItem>
   */
  default?: boolean;

  /**
   * Alternative name (in case you prefer avoiding the `default` prop):
   * <TabItem isDefault> ... </TabItem>
   */
  isDefault?: boolean;

  children: React.ReactNode;
};

export function CustomTabsItem(_props: CustomTabsItemProps) {
  // Declarative-only component. CustomTabs reads the props and renders Radix Tabs.
  return null;
}

export type CustomTabsProps = {
  children: React.ReactNode;
  className?: string;
  listClassName?: string;
  triggerClassName?: string;
  contentClassName?: string;
};

/**
 * Detect a "TabItem-like" element by props shape (robust for MDX),
 * instead of relying on component identity.
 */
function isTabItemLike(
  node: React.ReactNode
): node is React.ReactElement<CustomTabsItemProps> {
  if (!React.isValidElement(node)) return false;

  const props: any = node.props;
  return (
    props &&
    typeof props.value === "string" &&
    props.value.length > 0 &&
    props.label != null
  );
}

export function CustomTabs({
  children,
  className,
  listClassName,
  triggerClassName,
  contentClassName,
}: CustomTabsProps) {
  const items = React.Children.toArray(children).filter(isTabItemLike);

  if (items.length === 0) {
    // Fail loudly in dev so you can spot it immediately.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "CustomTabs: no <CustomTabsItem /> (or TabItem-like) children were found. " +
          "Make sure each child has `value` and `label` props."
      );
    }
    return null;
  }

  const defaultItem =
    items.find((el) => Boolean(el.props.default || el.props.isDefault)) ??
    items[0];

  return (
    <Tabs.Root
      defaultValue={defaultItem.props.value}
      className={["not-prose my-4", className].filter(Boolean).join(" ")}
    >
      {/* Docusaurus-like header: just labels + underline, no box */}
      <Tabs.List
        className={[
          "flex gap-6 border-b border-fd-border",
          listClassName,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {items.map((el) => (
          <Tabs.Trigger
            key={el.props.value}
            value={el.props.value}
            className={[
              "-mb-px py-2 text-sm font-medium whitespace-nowrap",
              "text-fd-muted-foreground",
              "data-[state=active]:text-fd-foreground",
              "data-[state=active]:border-b-2 data-[state=active]:border-fd-primary",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-fd-background",
              triggerClassName,
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {el.props.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>

      {items.map((el) => (
        <Tabs.Content
          key={el.props.value}
          value={el.props.value}
          className={["pt-3 outline-none", contentClassName]
            .filter(Boolean)
            .join(" ")}
        >
          {el.props.children}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
