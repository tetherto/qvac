import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';
import { customTree } from '@/lib/custom-tree';
import type { LinkItemType } from 'fumadocs-ui/layouts/shared';
import { FaGithub, FaDiscord } from 'react-icons/fa6';
import { SiHuggingface } from '@icons-pack/react-simple-icons';
import { FeaturebaseIcon } from '@/components/featurebase-icon';

export default function Layout({ children }: LayoutProps<'/'>) {

  const linkItems: LinkItemType[] = [
    {
      type: 'icon',
      url: 'https://github.com/tetherto/qvac-sdk',
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
      icon: <img
        src="/keet.svg"
        alt="Keet"
        width={24}
        height={24}
        className="h-4 w-4 object-contain"
      />,
    },
  ];

  return (
    <DocsLayout 
      {...baseOptions()}  
      tree={{ 
          name: 'docs',
          children: customTree
        }} 
      //{...base}
      //nav={{ ...nav, mode: 'top' }}
      links={linkItems}
      >
      {children}
    </DocsLayout>
  );
}
