import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { GoogleTagManager } from '@next/third-parties/google';
import { InkeepScript } from '@/components/inkeep-script';
import { Provider } from "./provider";
import 'katex/dist/katex.css';
import { docsRootMetadataRobots } from '@/lib/docs-indexing';
import { DOCS_SITE_ORIGIN } from '@/lib/docs-open-graph';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(DOCS_SITE_ORIGIN),
  title: {
    default: 'QVAC by Tether',
    template: '%s | QVAC',
  },
  description: 'Official documentation and single source of truth for QVAC.',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/favicon.png', type: 'image/png', sizes: '96x96' },
    ],
  },
  robots: docsRootMetadataRobots(),
};

const gtmId = process.env.NEXT_PUBLIC_GTM_ID ?? 'GTM-WDD9NCZ4';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html 
      lang="en" 
      suppressHydrationWarning
      className={inter.className}>
      <head>
        <meta property="og:logo" content={`${DOCS_SITE_ORIGIN}/qvac-logo.svg`} />
      </head>
      {gtmId && <GoogleTagManager gtmId={gtmId} />}
      <body className="flex flex-col min-h-screen">
        <InkeepScript />
          <Provider>{children}</Provider>
      </body>
    </html>
  );
}
