import './global.css';
import { Inter, Inconsolata } from 'next/font/google';
import type { Metadata, Viewport } from 'next';
import { GoogleTagManager } from '@next/third-parties/google';
import { AskAIProvider } from '@/components/ask-ai';
import { Provider } from "./provider";
import 'katex/dist/katex.css';
import { docsRootMetadataRobots } from '@/lib/docs-indexing';
import { DOCS_SITE_ORIGIN } from '@/lib/docs-open-graph';

const inter = Inter({
  subsets: ['latin'],
});

// Used by the Keet community modal to match the main site (qvac.tether.io).
const inconsolata = Inconsolata({
  subsets: ['latin'],
  variable: '--font-inconsolata',
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

// `viewportFit: cover` lets `env(safe-area-inset-*)` resolve to real
// values on notched devices (used by the Ask AI shell's bottom
// padding). `interactiveWidget: resizes-content` shrinks the layout
// viewport when the on-screen keyboard opens so the fixed chat panel
// rides above the keyboard instead of being hidden behind it.
export const viewport: Viewport = {
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

const gtmId = process.env.NEXT_PUBLIC_GTM_ID ?? 'GTM-WDD9NCZ4';

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html 
      lang="en" 
      suppressHydrationWarning
      className={`${inter.className} ${inconsolata.variable}`}>
      <head>
        <meta property="og:logo" content={`${DOCS_SITE_ORIGIN}/qvac-logo.svg`} />
      </head>
      {gtmId && <GoogleTagManager gtmId={gtmId} />}
      <body className="flex flex-col min-h-screen">
        {/*
         * `AskAIProvider` stays at the root layout (and not inside
         * `(docs)/layout.tsx`) so the `Cmd/Ctrl+I` hotkey and the
         * `?assistant=...` deep-link handler are reachable from
         * every route, including non-docs pages. The actual UI
         * (Inkeep modal + bottom pill) is mounted by the `(docs)`
         * layout because it only makes sense on docs routes; see
         * `AskAILegacyShell` and `AskAIPill`.
         */}
        <AskAIProvider>
          <Provider>{children}</Provider>
        </AskAIProvider>
      </body>
    </html>
  );
}
