import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INCONSOLATA_FAMILY } from '@/lib/qvac-doc-og-fonts';

/**
 * Per [Fumadocs OG + Next](https://www.fumadocs.dev/docs/integrations/og/next): dynamic `ImageResponse`
 * with page title/description; layout uses site background, wordmark, and white Inconsolata.
 */

export const QVAC_DOC_OG_WIDTH = 1200;
export const QVAC_DOC_OG_HEIGHT = 630;

const OG_DESC_MAX = 260;

function truncateForOg(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

let logoDataUrl: string | null = null;
let bgDataUrl: string | null = null;

async function getLogoDataUrl() {
  if (logoDataUrl) return logoDataUrl;
  const svg = await readFile(join(process.cwd(), 'public', 'qvac-logo.svg'), 'utf8');
  logoDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  return logoDataUrl;
}

async function getOgBackgroundDataUrl() {
  if (bgDataUrl) return bgDataUrl;
  const buf = await readFile(join(process.cwd(), 'public', 'og-bg-image.png'));
  bgDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  return bgDataUrl;
}

export async function buildQvacDocOgImageElement(options: {
  title: string;
  description?: string;
}) {
  const [bgSrc, logoSrc] = await Promise.all([getOgBackgroundDataUrl(), getLogoDataUrl()]);
  const title = options.title;
  const description = options.description
    ? truncateForOg(options.description, OG_DESC_MAX)
    : undefined;

  return (
    <div
      style={{
        width: QVAC_DOC_OG_WIDTH,
        height: QVAC_DOC_OG_HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        fontFamily: INCONSOLATA_FAMILY,
        backgroundImage: `url(${bgSrc})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        padding: '48px 56px',
        gap: 20,
      }}
    >
      <img
        src={logoSrc}
        alt=""
        width={348}
        height={40}
        style={{ objectFit: 'contain', height: 40 }}
      />
      <p
        style={{
          margin: 0,
          fontSize: 56,
          fontWeight: 800,
          color: '#ffffff',
          lineHeight: 1.12,
          textShadow: '0 2px 28px rgba(0,0,0,0.55)',
        }}
      >
        {title}
      </p>
      {description ? (
        <p
          style={{
            margin: 0,
            fontSize: 28,
            fontWeight: 400,
            color: '#ffffff',
            lineHeight: 1.35,
            textShadow: '0 2px 20px rgba(0,0,0,0.5)',
          }}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}
