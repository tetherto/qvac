import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import { baseOptions } from '@/lib/layout.shared';
import type { LinkItemType } from 'fumadocs-ui/layouts/shared';
import { FaGithub, FaDiscord, FaXTwitter } from 'react-icons/fa6';
import { SiHuggingface } from '@icons-pack/react-simple-icons';
import { KeetIcon } from '@/components/keet-icon';
import KeetRoomModalMount from '@/components/keet-modal';
import { customTree } from '@/lib/custom-tree';
import {
  AskAISearchToggleLarge,
  AskAISearchToggleSmall,
  // AskAITextSelection,  // disabled while we sort out the legacy fallback
} from '@/components/ask-ai';
import { AskAILegacyShell, AskAIPill } from '@/components/ask-ai-legacy';

export default function Layout({ children }: LayoutProps<'/'>) {
  const linkItems: LinkItemType[] = [
    {
      type: 'icon',
      url: 'https://github.com/tetherto/qvac',
      icon: <FaGithub />,
      text: 'GitHub',
      external: true,
    },
    {
      type: 'icon',
      url: 'https://discord.com/invite/tetherdev',
      icon: <FaDiscord />,
      text: 'Discord',
      external: true,
    },
    {
      type: 'icon',
      url: '#keet-room',
      label: 'Keet',
      text: 'Keet',
      icon: <KeetIcon />,
    },
    {
      type: 'icon',
      url: 'https://huggingface.co/qvac',
      label: 'Hugging Face',
      text: 'Hugging Face',
      icon: <SiHuggingface />,
      external: true,
    },
    {
      type: 'icon',
      url: 'https://x.com/QVAC',
      label: 'X (Twitter)',
      text: 'X (Twitter)',
      icon: <FaXTwitter />,
      external: true,
    },
  ];

  const base = baseOptions();

  return (
    <>
      <DocsLayout
        {...base}
        nav={{ ...base.nav, mode: 'top' }}
        links={linkItems}
        tree={{ name: 'docs', $id: 'latest', children: customTree }}
        searchToggle={{
          components: {
            lg: <AskAISearchToggleLarge />,
            sm: <AskAISearchToggleSmall />,
          },
        }}
      >
        {children}
      </DocsLayout>
      {/*
       * Legacy fallback while the custom `AskAIChatShell` (composer +
       * chat panel) is parked for bug fixes:
       *  - `AskAILegacyShell` mounts a single Inkeep modal (chat-first)
       *    controlled by the same `AskAIProvider` state every existing
       *    trigger feeds.
       *  - `AskAIPill` is the bottom click-to-open bar that replaces
       *    the buggy composer.
       * Both are `position: fixed`, so they sit as siblings of
       * `<DocsLayout>` and don't interact with its grid template.
       */}
      <AskAILegacyShell />
      <AskAIPill />
      <KeetRoomModalMount />
      {/* AskAITextSelection disabled — re-enable by uncommenting the import above and rendering <AskAITextSelection /> here. */}
    </>
  );
}
