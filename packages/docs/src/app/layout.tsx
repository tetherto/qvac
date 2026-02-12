import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { InkeepScript } from "@/components/inkeep-script"; 
import { Provider } from "./provider";
import 'katex/dist/katex.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'QVAC by Tether',
  description: 'Official documentation and single source of truth for QVAC.',
  icons: {
    icon: '/qvac-favicon.svg',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html 
      lang="en" 
      suppressHydrationWarning
      className={inter.className}>
      <body className="flex flex-col min-h-screen">
        <InkeepScript />
          <Provider>{children}</Provider>
      </body>
    </html>
  );
}
