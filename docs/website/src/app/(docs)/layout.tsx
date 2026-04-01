import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';
import type { LinkItemType } from 'fumadocs-ui/layouts/shared';
import { FaGithub, FaDiscord } from 'react-icons/fa6';
import { SiHuggingface } from '@icons-pack/react-simple-icons';
import { FeaturebaseIcon } from '@/components/featurebase-icon';
import { KeetIcon } from '@/components/keet-icon';
import { VersionedLayout } from '@/components/versioned-layout';
import { getAllTrees } from '@/lib/trees';

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
      url: 'https://qvacbytether.featurebase.app/?b=68d07d333a52713329b11fa6',
      label: 'FeatureBase',
      text: 'FeatureBase',
      icon: <FeaturebaseIcon />,
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
      url: '/#community',
      label: 'Keet',
      text: 'Keet',
      icon: <KeetIcon />,
    },
  ];

  const versionedTrees = getAllTrees();

  return (
    <VersionedLayout
      {...baseOptions()}
      links={linkItems}
      versionedTrees={versionedTrees}
    >
      {children}
    </VersionedLayout>
  );
}
