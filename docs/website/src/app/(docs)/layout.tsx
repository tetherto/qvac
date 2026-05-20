import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import type { LinkItemType } from 'fumadocs-ui/layouts/shared';
import { FaGithub, FaDiscord, FaXTwitter } from 'react-icons/fa6';
import { SiHuggingface } from '@icons-pack/react-simple-icons';
import { KeetIcon } from '@/components/keet-icon';
import { customTree } from '@/lib/custom-tree';
import {
  AskAISearchToggleLarge,
  AskAISearchToggleSmall,
  AskAIShell,
  AskAITextSelection,
} from '@/components/ask-ai';

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

  return (
    <>
      <DocsLayout
        {...baseOptions()}
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
       * `AskAIShell` mounts the desktop bar/modal and the mobile
       * full-screen chat. It's `position: fixed` so it doesn't need to
       * be inside `<DocsLayout>` to position correctly. Keeping it as
       * a sibling avoids any interaction with Fumadocs's grid template.
       */}
      <AskAIShell />
      <AskAITextSelection />
    </>
  );
}
