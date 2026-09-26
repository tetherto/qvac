import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import { baseOptions } from '@/lib/layout.shared';
import type { LinkItemType } from 'fumadocs-ui/layouts/shared';
import { FaGithub, FaDiscord, FaGlobe, FaXTwitter } from 'react-icons/fa6';
import { SiHuggingface } from '@icons-pack/react-simple-icons';
import { KeetIcon } from '@/components/keet-icon';
import { ConnectMcpServer } from '@/components/for-ai-menu';
import { FOR_AI_ENTRIES, FOR_AI_LABEL } from '@/lib/for-ai-menu';
import KeetRoomModalMount from '@/components/keet-modal';
import { buildCustomTree, collectionTabs } from '@/lib/custom-tree';
import { collectionLines, packageLines } from '@/lib/lines';
import { LineSwitcher } from '@/components/line-switcher';
import { source } from '@/lib/source';
import {
  AskAISearchToggleLarge,
  AskAISearchToggleSmall,
  AskAIShell,
  // AskAITextSelection,  // disabled while we sort out the legacy fallback
} from '@/components/ask-ai';

export default function Layout({ children }: LayoutProps<'/'>) {
  // The bar is icon-only, so an entry's `label` is the anchor's `aria-label`
  // and the only name a reader who cannot see the glyph is given. `text` is
  // what the bar renders where it collapses into a menu. Both are required of
  // every entry.
  //
  // The product's own site leads, ahead of the places the project is found —
  // its repository, its chat rooms, its model host, its announcements. One is
  // what this documentation documents; the rest are where to encounter the
  // people who make it.
  //
  // The For AI menu leads the bar because it is the only entry that leads
  // further into this documentation rather than away from it, and because it
  // belongs beside the assistant: the assistant answers a question here, the
  // menu hands the documentation elsewhere.
  //
  // It names only the site-wide artifacts. Each is the top of a cascade that
  // resolves downward, so one entry point is offered rather than a list that
  // lengthens with every documentation line cut.
  const linkItems: LinkItemType[] = [
    {
      type: 'menu',
      text: FOR_AI_LABEL,
      items: FOR_AI_ENTRIES.map((entry) =>
        // The entry with no URL is the one that copies the MCP address
        // instead of navigating, which the framework has no shape for.
        entry.url === undefined
          ? { type: 'custom' as const, children: <ConnectMcpServer /> }
          : {
              text: entry.text,
              url: entry.url,
              icon: <entry.icon />,
              external: entry.external,
            },
      ),
    },
    {
      type: 'icon',
      url: 'https://qvac.tether.io',
      label: 'QVAC website',
      text: 'QVAC website',
      icon: <FaGlobe />,
      external: true,
    },
    {
      type: 'icon',
      url: 'https://github.com/tetherto/qvac',
      label: 'GitHub',
      icon: <FaGithub />,
      text: 'GitHub',
      external: true,
    },
    {
      type: 'icon',
      url: 'https://discord.com/invite/tetherdev',
      label: 'Discord',
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
        tabMode="navbar"
        links={linkItems}
        tabs={collectionTabs}
        sidebar={{
          // The banner slot is the last child of the sidebar header, so the
          // switcher lands after the collection control and directly above
          // the tree on every viewport, with no conditional layout of ours.
          banner: (
            <LineSwitcher
              collections={[
                ...collectionLines(source.getPages().map((page) => page.url)),
                ...packageLines(),
              ]}
            />
          ),
        }}
        tree={{
          name: 'docs',
          $id: 'latest',
          children: buildCustomTree(source.pageTree),
        }}
        slots={{
          searchTrigger: {
            full: AskAISearchToggleLarge,
            sm: AskAISearchToggleSmall,
          },
        }}
      >
        {children}
      </DocsLayout>
      {/*
       * Custom Mintlify-style assistant. The unified `AskAIShell`
       * mounts ONE persistent fixed container: a bottom-anchored
       * composer bar that morphs into the chat modal, driven by the
       * same `AskAIProvider` state every existing trigger feeds
       * (top-nav button, hotkey, deep link, Cmd/Ctrl+K search hijack).
       * It is `position: fixed`, so it sits as a sibling of
       * `<DocsLayout>` and doesn't interact with its grid template.
       *
       * The legacy Inkeep modal (`AskAILegacyShell` + `AskAIPill`) is
       * preserved under `@/components/ask-ai-legacy` as an unmounted
       * fallback should the custom shell need to be parked again.
       */}
      <AskAIShell />
      <KeetRoomModalMount />
      {/* AskAITextSelection disabled — re-enable by uncommenting the import above and rendering <AskAITextSelection /> here. */}
    </>
  );
}
