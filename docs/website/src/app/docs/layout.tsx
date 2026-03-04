import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layout';
import { baseOptions } from '@/lib/layout.shared';
import { VersionSwitcher } from '@/components/version-switcher';

export default function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DocsLayout
      tree={source.pageTree}
      {...baseOptions()}
      nav={{
        ...baseOptions().nav,
        title: 'QVAC',
        children: <VersionSwitcher />,
      }}
      sidebar={{
        banner: <VersionSwitcher />,
      }}
    >
      {children}
    </DocsLayout>
  );
}
