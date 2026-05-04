"use client";

import { useEffect, useState } from "react";
import {
  InkeepChatButton,
  type InkeepChatButtonProps,
} from "@inkeep/cxkit-react";

export function InkeepScript() {
  const [mounted, setMounted] = useState(false);
  // color mode sync target
  const [syncTarget, setSyncTarget] = useState<HTMLElement | null>(null);

  // We do this because document is not available in the server
  useEffect(() => {
    setMounted(true);
    setSyncTarget(document.documentElement);
  }, []);

  // Prevent SSR/first-render hydration mismatch (Inkeep generates dynamic IDs).
  if (!mounted || !syncTarget) return null;

  const config: InkeepChatButtonProps = {
    baseSettings: {
      apiKey: process.env.NEXT_PUBLIC_INKEEP_API_KEY!,
      primaryBrandColor: "#16E3C1", // your brand color, widget color scheme is derived from this
      organizationDisplayName: "QVAC",
      theme: {
        styles: [
          {
            key: "qvac-inkeep-chat-button-light",
            type: "style",
            value: `
              [data-theme='light'] .ikp-chat-button__button {
                background: #ffffff;
                border: 1px solid rgba(0, 0, 0, 0.12);
                box-shadow:
                  0 8px 24px rgba(0, 0, 0, 0.08),
                  0 1px 2px rgba(0, 0, 0, 0.06);
              }

              [data-theme='light'] .ikp-chat-button__button:hover {
                background: #f6f8fa;
              }

              [data-theme='light'] .ikp-chat-button__text {
                color: rgba(0, 0, 0, 0.82);
              }

              [data-theme='light'] .ikp-chat-button__avatar-content {
                border: none !important;
                box-shadow: none !important;
                outline: none !important;
                background: transparent !important;
                border-left: none !important;
              }
            `,
          },
        ],
      },
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
      // optional settings
    },
    searchSettings: {
      // optional settings
    },
    aiChatSettings: {
      // optional settings
      aiAssistantAvatar: "/favicon.ico", // use your own AI assistant avatar
      exampleQuestions: [
        "What is QVAC?",
        "How to get started with QVAC?",
        "How to embed QVAC in my app?",
      ],
    },
  };

  return <InkeepChatButton {...config} />;
}