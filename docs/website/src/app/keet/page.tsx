'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Download, ExternalLink } from 'lucide-react';
import { KEET, KeetMascot } from '@/components/keet-modal';
import { KeetIcon } from '@/components/keet-icon';

// Launcher page for the QVAC Keet room. Lives outside `(docs)` so it renders
// without the docs chrome (nav/sidebar) — this is a landing surface, not a
// docs article. The site-wide announcement bar from the root layout is kept
// intentionally: this page is itself a QVAC surface targeting a QVAC audience
// (users arriving from the README badge or socials to join the community), so
// the project news the bar carries is on-topic here.
//
// Why this page exists:
//   External surfaces like the repo README on GitHub cannot link straight to
//   the `keet://` deeplink — GitHub Markdown's HTML sanitizer strips anchors
//   whose href scheme is not on its allowlist. The README badge instead
//   points here, and this page attempts the deeplink on the user's behalf
//   plus provides the same visual fallback as the community modal (download
//   the app + QR + copy link + a manual "Open in Keet" button) for the case
//   where the app is not installed or the browser silently blocks the
//   custom-scheme navigation.
//
// Colours and layout mirror `KeetModalContent` in `@/components/keet-modal`
// so the two surfaces feel like the same product. The room link comes from
// the shared `KEET` constant (single source of truth).

const TEAL = '#16E3C1';
const DARK = '#171817';

export default function KeetLauncherPage() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== 'light';
  const [isCopied, setIsCopied] = useState(false);

  const openKeet = useCallback(() => {
    // Fire-and-forget navigation to the custom scheme. Browsers that have
    // Keet registered as a handler will open the app; others silently
    // ignore the navigation, leaving the fallback UI in place.
    window.location.href = KEET.card2.roomLink;
  }, []);

  useEffect(() => {
    // Attempt the deeplink once on mount, after paint, so the fallback UI is
    // already visible when the browser prompt (if any) appears.
    const timer = window.setTimeout(openKeet, 150);
    return () => window.clearTimeout(timer);
  }, [openKeet]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(KEET.card2.roomLink);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy Keet room link:', err);
    }
  }, []);

  const pageBg = isDark
    ? 'radial-gradient(60% 60% at 10% 110%, #16E3C1, #0b0c0b 60%)'
    : 'radial-gradient(60% 60% at 10% 110%, #16E3C1, #ffffff 65%)';
  const accent = isDark ? TEAL : '#00AF92';
  const cardBg = isDark ? DARK : '#ffffff';
  const cardShadow = isDark
    ? '0 0 10px 0 #16E3C1'
    : '0 0 0 1px rgba(0, 175, 146, 0.25)';
  const fg = isDark ? '#ffffff' : DARK;

  return (
    <main
      className="flex min-h-screen w-full items-center justify-center px-4 py-10"
      style={{
        background: pageBg,
        fontFamily: 'var(--font-inconsolata)',
        color: fg,
      }}
    >
      <div className="flex w-full max-w-[640px] flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1
            className="text-[28px] font-bold leading-[34px] sm:text-[32px] sm:leading-[38px]"
            style={{ color: fg }}
          >
            {KEET.title}
          </h1>
          <p
            className="text-[15px] leading-[20px]"
            style={{ color: accent }}
          >
            Your browser should have opened Keet. If nothing happened, use one
            of the options below.
          </p>
        </div>

        <div className="flex w-full flex-col items-stretch justify-center gap-4 sm:flex-row">
          {/* Step 1 — download the Keet app */}
          <div
            className="flex min-h-[340px] w-full flex-col items-center justify-between gap-2 rounded-[16px] p-4 text-center sm:w-[240px]"
            style={{ background: cardBg, boxShadow: cardShadow }}
          >
            <div className="flex flex-col items-center gap-2">
              <h2
                className="text-[26px] font-bold leading-[33px]"
                style={{ color: accent }}
              >
                {KEET.card1.step}
              </h2>
              <h3
                className="text-[19px] font-bold leading-[22px]"
                style={{ color: fg }}
              >
                {KEET.card1.title}
              </h3>
              <p
                className="text-[15px] font-medium leading-[18px]"
                style={{ color: accent }}
              >
                {KEET.card1.subtext}
              </p>
            </div>
            <KeetMascot className="my-1 size-[88px]" />
            <a
              href={KEET.card1.downloadLink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex w-[180px] max-w-full items-center justify-center gap-2 rounded-[8px] border px-4 py-[6px] text-[15px] leading-[22px] no-underline transition-opacity hover:opacity-70 hover:no-underline"
              style={{ borderColor: fg, color: fg }}
            >
              <Download className="size-[15px]" />
              Download
            </a>
          </div>

          {/* Step 2 — join the room */}
          <div
            className="flex min-h-[340px] w-full flex-col items-center gap-2 rounded-[16px] p-4 text-center sm:w-[240px]"
            style={{ background: cardBg, boxShadow: cardShadow }}
          >
            <h2
              className="text-[26px] font-bold leading-[33px]"
              style={{ color: accent }}
            >
              {KEET.card2.step}
            </h2>
            <h3
              className="text-[19px] font-bold leading-[22px]"
              style={{ color: fg }}
            >
              {KEET.card2.title}
            </h3>
            <p className="text-[15px] leading-[18px]" style={{ color: accent }}>
              {KEET.card2.subtext}
            </p>
            <div className="relative rounded-[8px] bg-white p-2">
              <QRCodeSVG
                value={KEET.card2.roomLink}
                size={112}
                bgColor="#ffffff"
                fgColor="#000000"
                level="M"
              />
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span
                  className="flex items-center justify-center rounded-[4px] bg-white"
                  style={{ width: 30, height: 30, color: TEAL }}
                >
                  <KeetIcon className="size-[22px]" />
                </span>
              </span>
            </div>
            <div className="mt-1 flex w-[85%] items-center justify-between gap-2">
              <p
                className="truncate text-[9px] leading-[14px]"
                style={{ color: accent }}
                title={KEET.card2.roomLink}
              >
                {KEET.card2.roomLink}
              </p>
              <button
                type="button"
                onClick={handleCopyLink}
                aria-label="Copy room link"
                className="flex size-5 shrink-0 items-center justify-center transition-opacity hover:opacity-70"
                style={{ color: accent }}
              >
                {isCopied ? (
                  <Check className="size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
              </button>
            </div>
            <button
              type="button"
              onClick={openKeet}
              className="mt-2 flex w-[200px] max-w-full items-center justify-center gap-2 rounded-[8px] px-4 py-[8px] text-[15px] font-medium leading-[22px] transition-opacity hover:opacity-80"
              style={{ background: accent, color: DARK }}
            >
              <ExternalLink className="size-[15px]" />
              Open in Keet
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
