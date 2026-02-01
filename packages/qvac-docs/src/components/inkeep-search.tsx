"use client";

import type { SharedProps } from "fumadocs-ui/components/dialog/search";
import {
  InkeepModalSearchAndChat,
  type InkeepModalSearchAndChatProps,
} from "@inkeep/cxkit-react";
import { useEffect, useState } from "react";

export default function CustomDialog(props: SharedProps) {
  const [syncTarget, setSyncTarget] = useState<HTMLElement | null>(null);
  const { open, onOpenChange } = props;
  // We do this because document is not available in the server
  useEffect(() => {
    setSyncTarget(document.documentElement);
  }, []);

  const config: InkeepModalSearchAndChatProps = {
    baseSettings: {
      apiKey: process.env.NEXT_PUBLIC_INKEEP_API_KEY!,
      primaryBrandColor: "#16E3C1", // your brand color, widget color scheme is derived from this
      organizationDisplayName: "QVAC",
      // ...optional settings
      colorMode: {
        sync: {
          target: syncTarget,
          attributes: ["class"],
          isDarkMode: (attributes) => !!attributes.class?.includes("dark"),
        },
      },
    },
    modalSettings: {
      isOpen: open,
      onOpenChange,
      // optional settings
      // Avoid reacting to the default `[data-inkeep-modal-trigger]` custom trigger,
      // since the site also has a chat trigger and we don't want both modals opening.
      triggerSelector: '[data-inkeep-modal-trigger="search"]',
    },
    searchSettings: {
      // optional settings
    },
    aiChatSettings: {
      // optional settings
      aiAssistantAvatar: "/qvac-favicon.ico", // use your own AI assistant avatar
      exampleQuestions: [
        "What is QVAC?",
        "Why Tether built QVAC?",
        "How to use QVAC?",
      ],
    },
  };
  return <InkeepModalSearchAndChat {...config} />;
}
